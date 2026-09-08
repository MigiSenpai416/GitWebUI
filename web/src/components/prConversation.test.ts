import { describe, expect, it } from "vitest";
import { activityKey, buildConversation } from "./prConversation";

describe("pull request conversation", () => {
  it("preserves GitHub timeline order and groups commits before references and reviews", () => {
    const result = buildConversation([
      { event: "committed", sha: "a", message: "First commit", author: { name: "Author", date: "2026-09-08T04:00:00Z" } },
      { event: "committed", sha: "b", message: "Second commit", author: { name: "Author" } },
      { event: "cross-referenced", source: { issue: { number: 8, title: "Follow-up", html_url: "https://github.com/a/b/pull/8", state: "open" } } },
      { event: "ready_for_review", id: 4 },
      { event: "reviewed", id: 2, submitted_at: "2026-09-08T02:00:00Z", state: "commented" },
      { event: "commented", id: 1, created_at: "2026-09-08T01:00:00Z" },
    ], [
      { id: 6, in_reply_to_id: 3, pull_request_review_id: 9, created_at: "2026-09-08T04:00:00Z" },
      { id: 3, pull_request_review_id: 2, path: "file.ts", created_at: "2026-09-08T02:00:00Z" },
    ]);
    expect(result.map((entry) => entry.kind)).toEqual(["commits", "event", "event", "review", "comment"]);
    expect(result[0].commits?.map((item) => item.sha)).toEqual(["a", "b"]);
    expect(result[3].threads).toMatchObject([{ comment: { id: 3 }, replies: [{ id: 6 }] }]);
  });

  it("waits for a review's timeline page before showing its threads", () => {
    expect(buildConversation([], [{ id: 3, pull_request_review_id: 2 }], false)).toEqual([]);
    expect(buildConversation([], [{ id: 3, pull_request_review_id: 2 }])).toMatchObject([{ kind: "thread", item: { id: 3 } }]);
  });

  it("does not merge commits across events or different authors", () => {
    const result = buildConversation([
      { event: "committed", sha: "a", author: { name: "A" } },
      { event: "committed", sha: "b", author: { name: "B" } },
      { event: "ready_for_review", id: 1 },
      { event: "committed", sha: "c", author: { name: "B" } },
    ], []);
    expect(result).toHaveLength(4);
  });

  it("keeps blank approvals and hides notification bookkeeping", () => {
    const result = buildConversation([
      { event: "reviewed", id: 1, state: "approved", body: "" },
      { event: "subscribed", id: 2 }, { event: "mentioned", id: 3 },
      { event: "review_dismissed", id: 4 },
    ], []);
    expect(result.map((entry) => entry.item.id)).toEqual([1, 4]);
  });

  it("does not collapse ID-less commits and cross references or overlapping numeric IDs", () => {
    const items = [
      { event: "committed", sha: "a" }, { event: "committed", sha: "b" },
      { event: "cross-referenced", created_at: "first" }, { event: "cross-referenced", created_at: "second" },
      { event: "commented", id: 1 }, { event: "reviewed", id: 1 },
    ];
    expect(new Set(items.map(activityKey)).size).toBe(items.length);
  });
});
