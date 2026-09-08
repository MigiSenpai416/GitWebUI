import { afterEach, describe, expect, it, vi } from "vitest";
import { actOnPullRequest, listPullRequests, pullRequestActivity, pullRequestChecks, pullRequestDetails } from "./pullRequests.js";

const pull = {
  number: 7, title: "Improve navigation", body: null, html_url: "https://github.com/owner/repo/pull/7",
  state: "closed", draft: false, merged_at: "2026-09-08T00:00:00Z", user: { login: "author" },
  assignees: [{ login: "viewer" }], requested_reviewers: [{ login: "reviewer" }], requested_teams: [{ slug: "ui" }],
  labels: [{ name: "enhancement" }], updated_at: "2026-09-08T00:00:00Z", head: { label: "fork:feature", sha: "a".repeat(40) },
  base: { label: "owner:main" }, mergeable: true, mergeable_state: "clean", additions: 2, deletions: 1, changed_files: 1, commits: 1,
};

afterEach(() => vi.restoreAllMocks());

describe("pull request browsing", () => {
  it("enriches timeline commits with GitHub authors and check results without reordering", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json([{ event: "committed", node_id: "commit-node", sha: "a" }, { event: "ready_for_review", id: 1 }]))
      .mockResolvedValueOnce(Response.json({ data: { nodes: [{ oid: "a", author: { user: { login: "author", avatarUrl: "https://avatars.githubusercontent.com/u/1" } }, statusCheckRollup: { state: "FAILURE" } }] } }));
    expect(await pullRequestActivity("token", "owner/repo", 7, "timeline", 1)).toMatchObject({ items: [
      { event: "committed", user: { login: "author" }, check_state: "FAILURE" }, { event: "ready_for_review" },
    ] });
  });

  it("keeps the timeline readable when additional commit metadata is inaccessible", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json([{ event: "committed", node_id: "commit-node", sha: "a" }]))
      .mockResolvedValueOnce(Response.json({ errors: [{ message: "Checks permission denied" }] }));
    expect(await pullRequestActivity("token", "owner/repo", 7, "timeline", 1)).toMatchObject({ items: [{ sha: "a" }], warning: "Commit details unavailable: Checks permission denied" });
  });

  it("loads persisted thread state across GraphQL pages using comment node IDs", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true, isOutdated: false, isCollapsed: true, comments: { nodes: [{ id: "comment-1" }] } }], pageInfo: { hasNextPage: true, endCursor: "next" } } } } } }))
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, isOutdated: true, isCollapsed: false, comments: { nodes: [{ id: "comment-2" }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
    expect(await pullRequestActivity("token", "owner/repo", 7, "thread-states", 1)).toEqual({ items: [
      { node_id: "comment-1", is_resolved: true, is_outdated: false, is_collapsed: true },
      { node_id: "comment-2", is_resolved: false, is_outdated: true, is_collapsed: false },
    ], hasMore: false });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).variables).toEqual({ owner: "owner", name: "repo", number: 7, cursor: "next" });
  });

  it("reports GraphQL errors instead of treating unknown thread states as unresolved", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ errors: [{ message: "Access denied" }] }));
    await expect(pullRequestActivity("token", "owner/repo", 7, "thread-states", 1)).rejects.toThrow("Access denied");
  });

  it("returns the native timeline in upstream order including ID-less commits and references", async () => {
    const items = [{ event: "committed", sha: "a" }, { event: "cross-referenced", source: { issue: { number: 8 } } }, { event: "ready_for_review", id: 1 }];
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(items));
    expect(await pullRequestActivity("token", "owner/repo", 7, "timeline", 2)).toEqual({ items, hasMore: false });
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/repos/owner/repo/issues/7/timeline?per_page=100&page=2");
  });
  it("maps merged PRs and people and preserves pagination", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(Array(100).fill(pull)));
    const result = await listPullRequests("token", "owner/repo", "closed", 2);
    expect(String(fetch.mock.calls[0][0])).toContain("state=closed&sort=updated&direction=desc&per_page=100&page=2");
    expect(result.hasMore).toBe(true);
    expect(result.items[0]).toMatchObject({ state: "merged", body: "", assignees: ["viewer"], reviewers: ["reviewer"], teams: ["ui"] });
  });

  it("derives permissions and merge methods from the repository and viewer", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/user")) return Response.json({ login: "viewer", id: 1 });
      if (String(url).endsWith("/pulls/7")) return Response.json({ ...pull, state: "open", merged_at: null });
      return Response.json({ permissions: { push: false }, allow_squash_merge: true });
    });
    expect(await pullRequestDetails("token", "owner/repo", 7)).toMatchObject({ canMerge: false, canEdit: false, canReview: true, mergeMethods: ["squash"] });
  });

  it("does not present inaccessible checks as a successful empty result", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/pulls/7")) return Response.json(pull);
      if (String(url).includes("check-runs")) return Response.json({ message: "Checks permission missing" }, { status: 403 });
      return Response.json({ statuses: [{ id: 1, state: "failure" }], total_count: 1 });
    });
    expect(await pullRequestChecks("token", "owner/repo", 7, 1)).toMatchObject({ sha: pull.head.sha, checks: [], statuses: [{ state: "failure" }], errors: ["Checks permission missing"] });
  });

  it("rejects unsupported activity endpoints before sending a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(pullRequestActivity("token", "owner/repo", 7, "../secrets", 1)).rejects.toThrow("Unknown");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("pull request actions", () => {
  it("anchors a new code comment to the inspected commit, path and deleted line", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(pull)).mockResolvedValueOnce(Response.json({ id: 30 }));
    await actOnPullRequest("token", "owner/repo", 7, { action: "code-comment", path: "old.ts", line: 12, side: "LEFT", body: "Keep this behavior", sha: pull.head.sha });
    expect(fetch.mock.calls[1][0]).toBe("https://api.github.com/repos/owner/repo/pulls/7/comments");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ body: "Keep this behavior", commit_id: pull.head.sha, path: "old.ts", line: 12, side: "LEFT" });
  });

  it("rejects stale diffs before posting a line comment", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(pull));
    await expect(actOnPullRequest("token", "owner/repo", 7, { action: "code-comment", path: "file.ts", line: 1, side: "RIGHT", body: "Review", sha: "b".repeat(40) })).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("posts a code reply to its thread rather than the general conversation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: 22, in_reply_to_id: 11, body: "Fixed" }));
    expect(await actOnPullRequest("token", "owner/repo", 7, { action: "reply", commentId: 11, body: "Fixed" })).toMatchObject({ ok: true, reply: { id: 22, in_reply_to_id: 11 } });
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/repos/owner/repo/pulls/7/comments/11/replies");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ body: "Fixed" }) });
  });
  it("pins merges to the inspected SHA and handles a non-merged response", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ merged: false, message: "Head changed" }));
    await expect(actOnPullRequest("token", "owner/repo", 7, { action: "merge", method: "squash", sha: pull.head.sha })).rejects.toThrow("Head changed");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "PUT", body: JSON.stringify({ sha: pull.head.sha, merge_method: "squash" }) });
  });

  it("submits a review against the inspected commit", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: 1 }));
    await actOnPullRequest("token", "owner/repo", 7, { action: "review", event: "REQUEST_CHANGES", body: "Please cover this case", sha: pull.head.sha });
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ body: "Please cover this case", event: "REQUEST_CHANGES", commit_id: pull.head.sha }) });
  });

  it.each([
    { action: "code-comment", path: "file", line: 0, side: "RIGHT", body: "Test" },
    { action: "code-comment", path: "file", line: 1, side: "MIDDLE", body: "Test" },
    { action: "reply", commentId: 0, body: "Fixed" }, { action: "reply", commentId: 1, body: " " },
    { action: "comment", body: " " }, { action: "review", event: "DELETE" },
    { action: "review", event: "REQUEST_CHANGES", body: "" }, { action: "merge", method: "force", sha: pull.head.sha },
    { action: "merge", method: "merge", sha: "" }, { action: "edit", title: " " }, { action: "delete" },
  ])("rejects invalid input without a GitHub write: %j", async (input) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(actOnPullRequest("token", "owner/repo", 7, input)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
