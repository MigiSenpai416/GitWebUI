import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { launchApp, cleanupApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test("pull request pagination, refresh failures and late details keep repository context", async () => {
  const repo = makeRepo();
  let started: TestApp | undefined;
  try {
    started = await launchApp();
    const window = await started.app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    const repository = (name: string) => ({ fullName: `example/${name}`, name, owner: "example", defaultBranch: "main", private: false, isFork: false, parentFullName: null });
    const summary = (number: number, name: string) => ({ number, title: `${name} change ${number}`, body: "Details", state: "open", draft: false, author: "viewer", assignees: [], reviewers: [], teams: [], labels: [], updatedAt: "2026-09-08T00:00:00Z", head: "topic", base: "main", sha: "a".repeat(40) });
    let fail = false;
    let release: (() => void) | undefined;
    await window.route("**/api/github/status", (route) => route.fulfill({ json: { configured: true, user: { login: "viewer" } } }));
    await window.route("**/api/pr/context", (route) => route.fulfill({ json: {
      baseCandidates: [repository("first"), repository("second")], defaults: { baseRepo: "example/first" },
    } }));
    await window.route("**/api/pr/list?**", (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (fail) return route.fulfill({ status: 422, json: { error: "GitHub temporarily unavailable" } });
      const name = params.get("repo")!.split("/")[1];
      const page = Number(params.get("page"));
      return route.fulfill({ json: { items: page === 1 ? [summary(1, name)] : [summary(2, name)], hasMore: page === 1 } });
    });
    await window.route("**/api/pr/details?**", async (route) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await route.fulfill({ json: { ...summary(1, "late first"), mergeable: false, mergeableState: "dirty", canEdit: false, canMerge: false, canComment: false, canReview: false, mergeMethods: [], changedFiles: 0, commits: 0 } }).catch(() => {});
    });
    await window.reload();
    await window.getByRole("button", { name: "Open", exact: true }).first().click();
    await window.locator(".picker-form input").fill(repo);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.locator(".prs-group")).toHaveCount(4);
    await expect(window.locator(".prs-group[aria-expanded=true]")).toHaveCount(0);
    await expect(window.locator(".prs-item")).toHaveCount(0);
    await window.getByRole("button", { name: "All Pull Requests" }).click();
    await expect(window.locator(".prs-item")).toHaveCount(1);
    await window.getByRole("button", { name: "Load more pull requests" }).click();
    await expect(window.locator(".prs-item")).toHaveCount(2);
    await window.getByLabel("Pull request repository").selectOption("example/second");
    await expect(window.locator(".prs-group[aria-expanded=true]")).toHaveCount(0);
    await window.getByRole("button", { name: "All Pull Requests" }).click();
    await expect(window.locator(".prs-item")).toHaveCount(1);
    await expect(window.locator(".prs-item")).toContainText("second change 1");
    await window.getByRole("button", { name: "Refresh pull requests" }).click({ force: true });
    await expect(window.getByLabel("Pull request repository")).toHaveValue("example/second");
    await expect(window.locator(".prs-item")).toContainText("second change 1");
    fail = true;
    await window.getByRole("button", { name: "Refresh pull requests" }).click({ force: true });
    await expect(window.getByRole("alert")).toContainText("GitHub temporarily unavailable");
    fail = false;
    await window.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(window.locator(".prs-item")).toContainText("second change 1");
    await window.locator(".prs-item").click();
    await expect(window.getByRole("dialog", { name: "Pull request #1" })).toContainText("Loading pull request");
    await window.getByRole("button", { name: "Close pull request dialog" }).click();
    await window.getByLabel("Pull request repository").selectOption("example/first");
    await expect(window.locator(".prs-group[aria-expanded=true]")).toHaveCount(0);
    await window.getByRole("button", { name: "All Pull Requests" }).click();
    release?.();
    await expect(window.locator(".prs-item")).toContainText("first change 1");
    await expect(window.getByRole("dialog", { name: "Pull request #1" })).toHaveCount(0);
    await expect(window.getByText("late first change 1")).toHaveCount(0);
  } finally {
    if (started) { await started.app.close(); await cleanupApp(started); }
    await removeRepo(repo);
  }
});

test("pull requests browse, review, edit, close, reopen and merge through the local API", async () => {
  test.setTimeout(120_000);
  const repo = makeRepo();
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/example/project.git"]);
  let started: TestApp | undefined;
  try {
    started = await launchApp();
    await started.app.evaluate(() => {
      const pr = {
        number: 7, title: "Improve sidebar navigation", body: "## Summary\n\nMake **navigation** easier.\n\n- Keep context\n- Support keyboard users",
        html_url: "https://github.com/example/project/pull/7", state: "open", draft: false, merged_at: null as string | null,
        user: { login: "contributor" }, assignees: [{ login: "viewer" }], requested_reviewers: [{ login: "viewer" }], requested_teams: [],
        labels: [{ name: "enhancement" }], updated_at: "2026-09-08T01:00:00Z", head: { label: "contributor:sidebar", ref: "sidebar", sha: "a".repeat(40) },
        base: { label: "example:main", ref: "main" }, mergeable: true, mergeable_state: "clean", additions: 3, deletions: 1, changed_files: 1, commits: 1,
      };
      const comments: unknown[] = [];
      (globalThis as unknown as { prFixture: typeof pr }).prFixture = pr;
      const replies: unknown[] = [];
      const reviews: unknown[] = [{ id: 50, user: { login: "reviewer" }, body: "Please check the navigation behavior.\n\n<details><summary>Review context</summary>\n\nExtra review details.\n\n</details><script>window.prUnsafe = true</script>", state: "COMMENTED", submitted_at: "2026-09-08T01:00:00Z" }];
      let checkRequests = 0;
      let mergeRequests = 0;
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith("https://api.github.com/")) return original(input, init);
        const path = new URL(url).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (path === "/graphql") return Response.json({ data: { repository: { pullRequest: { reviewThreads: {
          nodes: [{ isResolved: false, isOutdated: false, isCollapsed: false, comments: { nodes: [{ id: "comment-1000" }] } },
            { isResolved: true, isOutdated: true, isCollapsed: true, comments: { nodes: [{ id: "comment-1002" }] } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } } });
        if (path === "/user") return Response.json({ login: "viewer", id: 1 });
        if (path === "/user/emails") return Response.json([]);
        if (path === "/repos/example/project") return Response.json({ full_name: "example/project", name: "project", owner: { login: "example" }, default_branch: "main", private: false, fork: false, permissions: { push: true }, allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true });
        if (path.endsWith("/pulls")) {
          const state = new URL(url).searchParams.get("state");
          return Response.json(state === "all" || pr.state === state ? [pr] : []);
        }
        if (path.endsWith("/pulls/7")) {
          if (init?.method === "PATCH") Object.assign(pr, body);
          return Response.json(pr);
        }
        if (path.endsWith("/issues/7/timeline")) return Response.json([
          { event: "committed", sha: "b".repeat(40), message: "Add sidebar structure", author: { name: "Contributor" } },
          { event: "committed", sha: "c".repeat(40), message: "Refine navigation", author: { name: "Contributor" } },
          { event: "cross-referenced", actor: { login: "contributor" }, source: { issue: { number: 8, title: "Follow-up navigation work", html_url: "https://github.com/example/project/pull/8", state: "open", draft: true } } },
          { event: "ready_for_review", id: 60, actor: { login: "contributor" } },
          ...reviews.map((item) => ({ ...(item as object), event: "reviewed" })),
          ...comments.map((item) => ({ ...(item as object), event: "commented" })),
        ]);
        if (path.endsWith("/issues/7/comments")) {
          if (init?.method === "POST" && body.body === "Rejected comment") return Response.json({ message: "Comment could not be saved" }, { status: 422 });
          if (init?.method === "POST") comments.push({ id: comments.length + 1, user: { login: "viewer" }, body: body.body, created_at: "2026-09-08T01:01:00Z" });
          return Response.json(init?.method === "POST" ? comments.at(-1) : comments);
        }
        if (path.endsWith("/reviews")) {
          if (init?.method === "POST") {
            if (body.commit_id !== pr.head.sha) return Response.json({ message: "Wrong SHA" }, { status: 422 });
            reviews.push({ id: reviews.length + 1, user: { login: "viewer" }, body: body.body, state: body.event === "APPROVE" ? "APPROVED" : body.event, submitted_at: "2026-09-08T01:02:00Z" });
          }
          return Response.json(init?.method === "POST" ? reviews.at(-1) : reviews);
        }
        if (path.endsWith("/merge")) {
          if (body.sha !== pr.head.sha || body.merge_method !== "squash") return Response.json({ merged: false, message: "Incorrect merge request" });
          if (body.commit_title !== "Ship sidebar navigation" || body.commit_message !== "Improve navigation.\n\nPreserve keyboard focus.") return Response.json({ merged: false, message: "Incorrect commit message" });
          if (mergeRequests++ === 0) return Response.json({ merged: false, message: "Merge temporarily blocked" });
          pr.state = "closed"; pr.merged_at = "2026-09-08T02:00:00Z";
          return Response.json({ merged: true, message: "Merged" });
        }
        if (path.endsWith("/files")) return Response.json([{ filename: "web/sidebar.tsx", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-old sidebar\n+new sidebar" }]);
        if (path.endsWith("/commits")) return Response.json([{ sha: pr.head.sha, commit: { message: "Improve navigation", author: { name: "Contributor", date: "2026-09-08T01:00:00Z" } } }]);
        if (path.endsWith("/check-runs")) {
          if (checkRequests++ === 0) return Response.json({ message: "Checks temporarily unavailable" }, { status: 403 });
          return Response.json({ total_count: 1, check_runs: [{ id: 1, name: "Build and test", status: "completed", conclusion: "success" }] });
        }
        if (path.endsWith("/status")) return Response.json({ total_count: 101, statuses: [{ id: 2, context: "Legacy CI", state: "success" }], state: "success" });
        if (path.endsWith("/pulls/7/comments/1000/replies")) {
          if (body.body === "Rejected reply") return Response.json({ message: "Reply could not be saved" }, { status: 422 });
          const reply = { id: 2000 + replies.length, in_reply_to_id: 1000, user: { login: "viewer" }, body: body.body, created_at: "2026-09-08T01:03:00Z" };
          replies.push(reply);
          return Response.json(reply);
        }
        if (path.endsWith("/pulls/7/comments") && init?.method === "POST") {
          if (body.body === "Rejected line comment") return Response.json({ message: "Line comment could not be saved" }, { status: 422 });
          if (body.commit_id !== pr.head.sha || body.path !== "web/sidebar.tsx" || body.line !== 1 || !["LEFT", "RIGHT"].includes(body.side)) return Response.json({ message: "Wrong line anchor" }, { status: 422 });
          const comment = { id: 3000 + replies.length, user: { login: "viewer" }, path: body.path, line: body.line, body: body.body, created_at: "2026-09-08T01:04:00Z" };
          replies.push(comment);
          return Response.json(comment);
        }
        if (path.endsWith("/pulls/7/comments")) return Response.json([
          { id: 1000, node_id: "comment-1000", pull_request_review_id: 50, user: { login: "reviewer" }, path: "navigation.ts", line: 1, diff_hunk: "@@ -1 +1 @@\n+const enabled = true;", body: "Keep keyboard focus visible.", created_at: "2026-09-08T01:00:00Z" },
          { id: 1001, in_reply_to_id: 1000, user: { login: "contributor" }, body: "Focus is preserved after switching tabs.", created_at: "2026-09-08T01:01:00Z" },
          { id: 1002, node_id: "comment-1002", pull_request_review_id: 50, user: { login: "reviewer" }, path: "resolved.ts", body: "Already addressed.", created_at: "2026-09-08T01:01:00Z" },
          ...replies,
        ]);
        return Response.json({ message: `Unexpected GitHub request: ${path}` }, { status: 404 });
      };
    });
    const window = await started.app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(async () => {
      const res = await fetch("/api/github/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "test-token" }) });
      if (!res.ok) throw new Error(await res.text());
    });
    await window.reload();
    await window.getByRole("button", { name: "Open", exact: true }).first().click();
    await window.locator(".picker-form input").fill(repo);
    await window.locator(".picker-form button[type=submit]").click();
    await window.getByRole("button", { name: "All Pull Requests" }).click();
    await expect(window.getByRole("button", { name: "#7 Improve sidebar navigation", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "Assigned to Me" }).click();
    await expect(window.getByRole("button", { name: "#7 Improve sidebar navigation", exact: true })).toHaveCount(2);
    await window.getByRole("button", { name: "#7 Improve sidebar navigation", exact: true }).first().click();
    const dialog = window.getByRole("dialog", { name: "Pull request #7", exact: true });
    await expect(dialog.getByText("Make navigation easier.")).toBeVisible();
    await expect(dialog.getByRole("tab")).toHaveText(["Conversation", "Commits (1)", "Checks", "Files changed (1)"]);
    await expect(dialog.locator(".prv-timeline-entry").nth(0)).toContainText("added 2 commits");
    await expect(dialog.locator(".prv-timeline-entry").nth(1)).toContainText("Follow-up navigation work");
    await expect(dialog.locator(".prv-timeline-entry").nth(2)).toContainText("marked this pull request as ready for review");
    await expect(dialog.locator(".prv-timeline-entry").nth(3)).toContainText("Please check the navigation behavior.");
    await expect(dialog.getByText("Extra review details.")).not.toBeVisible();
    await dialog.locator("summary").filter({ hasText: "Review context" }).click();
    await expect(dialog.getByText("Extra review details.")).toBeVisible();
    expect(await window.evaluate(() => (window as unknown as { prUnsafe?: boolean }).prUnsafe)).toBeUndefined();
    await expect(dialog.locator(".prv-timeline-review .prv-code-thread").first()).toContainText("Keep keyboard focus visible.");
    await expect(dialog.locator(".prv-timeline-review .prv-code-thread").first()).toContainText("Focus is preserved after switching tabs.");
    await expect(dialog.locator(".prv-code-thread").nth(1)).toContainText("Resolved");
    await expect(dialog.locator(".prv-code-thread").nth(1)).not.toHaveAttribute("open");
    await expect(dialog.getByText("Already addressed.")).not.toBeVisible();
    const thread = dialog.locator(".prv-code-thread").first();
    await thread.getByLabel("Reply to code comment").fill("Rejected reply");
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread.getByRole("alert")).toContainText("Reply could not be saved");
    await expect(thread.getByLabel("Reply to code comment")).toHaveValue("Rejected reply");
    await thread.getByLabel("Reply to code comment").fill("Thanks, verified the keyboard behavior.");
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread.getByText("Thanks, verified the keyboard behavior.", { exact: true })).toBeVisible();
    await expect(thread.getByLabel("Reply to code comment")).toHaveValue("");
    await dialog.getByRole("tab", { name: "Files changed (1)" }).click();
    await dialog.locator("summary").click();
    await expect(dialog.getByText("+new sidebar", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Comment on old line 1 in web/sidebar.tsx", exact: true }).click();
    await dialog.getByLabel("Code comment on web/sidebar.tsx").fill("Rejected line comment");
    await dialog.getByRole("button", { name: "Add single comment" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Line comment could not be saved");
    await expect(dialog.getByLabel("Code comment on web/sidebar.tsx")).toHaveValue("Rejected line comment");
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
    await dialog.locator(".prv-entry summary").click();
    await expect(dialog.getByText("Your comment draft is saved. Select a line to continue.")).toBeVisible();
    await dialog.getByRole("button", { name: "Comment on old line 1 in web/sidebar.tsx", exact: true }).click();
    await expect(dialog.getByLabel("Code comment on web/sidebar.tsx")).toHaveValue("Rejected line comment");
    await dialog.getByLabel("Code comment on web/sidebar.tsx").fill("Please preserve this old behavior.");
    await dialog.getByRole("button", { name: "Add single comment" }).click();
    await expect(dialog.getByLabel("Code comment on web/sidebar.tsx")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Comment on new line 1 in web/sidebar.tsx", exact: true }).click();
    await dialog.getByLabel("Code comment on web/sidebar.tsx").fill("The new behavior looks correct.");
    await dialog.getByRole("button", { name: "Add single comment" }).click();
    await expect(dialog.getByLabel("Code comment on web/sidebar.tsx")).toHaveCount(0);
    await dialog.getByRole("tab", { name: "Checks", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Checks temporarily unavailable");
    await expect(dialog.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Retry checks", exact: true }).click();
    await expect(dialog.getByText("Build and test", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Legacy CI", { exact: true })).toHaveCount(1);
    await started.app.evaluate(() => {
      (globalThis as unknown as { prFixture: { head: { sha: string } } }).prFixture.head.sha = "b".repeat(40);
    });
    await dialog.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Refresh the pull request to load checks for its latest commit");
    await expect(dialog.getByText("Legacy CI", { exact: true })).toHaveCount(1);
    await started.app.evaluate(() => {
      (globalThis as unknown as { prFixture: { head: { sha: string } } }).prFixture.head.sha = "a".repeat(40);
    });
    await dialog.getByRole("tab", { name: "Commits (1)" }).click();
    await expect(dialog.getByText("Improve navigation", { exact: true })).toBeVisible();
    await dialog.getByRole("tab", { name: "Conversation" }).click();
    await expect(dialog.getByText("Please preserve this old behavior.", { exact: true })).toBeVisible();
    await expect(dialog.getByText("The new behavior looks correct.", { exact: true })).toBeVisible();
    await dialog.getByLabel("Comment or review").fill("Rejected comment");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Comment could not be saved");
    await expect(dialog.getByLabel("Comment or review")).toHaveValue("Rejected comment");
    await dialog.getByLabel("Comment or review").fill("Looks good from the desktop app.");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(dialog.getByText("Looks good from the desktop app.", { exact: true })).toBeVisible();
    await dialog.getByRole("tab", { name: "Files changed (1)" }).click();
    await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
    await expect(dialog.getByLabel("Review summary")).toBeFocused();
    await expect(dialog.getByLabel("Review summary")).toBeInViewport();
    await dialog.getByRole("radio", { name: "Approve", exact: false }).check();
    await dialog.getByRole("button", { name: "Submit review" }).click();
    await window.locator(".confirm-bar").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("Pull request updated.");
    await expect(dialog.getByRole("tab", { name: "Conversation", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByText("approved these changes", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Edit title and description" }).click();
    await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
    await expect(dialog.getByLabel("Title", { exact: true })).toBeInViewport();
    await dialog.getByLabel("Title", { exact: true }).fill("Polish sidebar navigation");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.locator(".dialog-title")).toHaveText("Polish sidebar navigation");
    await dialog.getByRole("button", { name: "Close PR", exact: true }).click();
    await window.locator(".confirm-bar").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Reopen PR" })).toBeVisible();
    await dialog.getByRole("button", { name: "Reopen PR" }).click();
    await window.locator(".confirm-bar").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Merge PR" })).toBeEnabled();
    await dialog.getByRole("checkbox", { name: "Customize commit message" }).check();
    await dialog.getByRole("textbox", { name: "Merge commit title" }).fill("");
    await expect(dialog.getByRole("button", { name: "Merge PR" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Merge commit title" }).fill("Ship sidebar navigation");
    await dialog.getByRole("textbox", { name: "Merge commit description" }).fill("Improve navigation.\n\nPreserve keyboard focus.");
    await dialog.getByLabel("Merge method").selectOption("merge");
    await dialog.getByRole("textbox", { name: "Merge commit title" }).fill("Merge-method title");
    await dialog.getByRole("textbox", { name: "Merge commit description" }).fill("Merge-method description");
    await dialog.getByLabel("Merge method").selectOption("rebase");
    await expect(dialog.getByRole("textbox", { name: "Merge commit title" })).toHaveCount(0);
    await expect(dialog.getByText("Rebase preserves the individual commit messages.")).toBeVisible();
    await dialog.getByLabel("Merge method").selectOption("squash");
    await expect(dialog.getByRole("textbox", { name: "Merge commit title" })).toHaveValue("Ship sidebar navigation");
    await dialog.getByRole("checkbox", { name: "Customize commit message" }).uncheck();
    await expect(dialog.getByRole("textbox", { name: "Merge commit title" })).toHaveCount(0);
    await dialog.getByRole("checkbox", { name: "Customize commit message" }).check();
    await dialog.getByRole("tab", { name: "Commits (1)", exact: true }).click();
    await dialog.getByRole("tab", { name: "Conversation", exact: true }).click();
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Merge PR" })).toBeEnabled();
    await expect(dialog.getByRole("textbox", { name: "Merge commit title" })).toHaveValue("Ship sidebar navigation");
    await dialog.getByRole("button", { name: "Merge PR" }).click();
    await expect(dialog.getByRole("textbox", { name: "Merge commit title" })).toBeDisabled();
    await window.locator(".confirm-bar").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Merge commit title" })).toBeEnabled();
    await expect(dialog.getByRole("textbox", { name: "Merge commit description" })).toHaveValue("Improve navigation.\n\nPreserve keyboard focus.");
    await dialog.getByRole("button", { name: "Merge PR" }).click();
    await window.locator(".confirm-bar").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Merge temporarily blocked");
    await expect(dialog.getByRole("textbox", { name: "Merge commit description" })).toHaveValue("Improve navigation.\n\nPreserve keyboard focus.");
    await dialog.getByRole("button", { name: "Merge PR" }).click();
    await window.locator(".confirm-bar").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog.getByText("This pull request is merged.")).toBeVisible();
    await dialog.getByRole("button", { name: "Close pull request dialog" }).click();
    await expect(window.locator(".prs-item")).toHaveCount(0);
    await window.getByLabel("Pull request state").selectOption("merged");
    await expect(window.locator(".prs-item").first()).toContainText("Polish sidebar navigation");
    await window.getByLabel("Search pull requests").fill("not present");
    await expect(window.locator(".prs-item")).toHaveCount(0);
  } finally {
    if (started) { await started.app.close(); await cleanupApp(started); }
    await removeRepo(repo);
  }
});

test("conversation pagination keeps native event order and waits for a review before attaching threads", async () => {
  const repo = makeRepo();
  let started: TestApp | undefined;
  try {
    started = await launchApp();
    const window = await started.app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    const pr = { number: 1, title: "Timeline ordering", body: "Description", state: "open", draft: false, author: "author", assignees: [], reviewers: [], teams: [], labels: [], updatedAt: "2026-09-08T00:00:00Z", head: "topic", base: "main", sha: "a".repeat(40), mergeable: false, mergeableState: "dirty", canEdit: false, canMerge: false, canComment: true, canReview: false, mergeMethods: [], changedFiles: 0, commits: 2 };
    let fail = true;
    await window.route("**/api/github/status", (route) => route.fulfill({ json: { configured: true, user: { login: "viewer" } } }));
    await window.route("**/api/pr/context", (route) => route.fulfill({ json: { baseCandidates: [{ fullName: "example/project", name: "project", owner: "example" }], defaults: { baseRepo: "example/project" } } }));
    await window.route("**/api/pr/list?**", (route) => route.fulfill({ json: { items: [pr], hasMore: false } }));
    await window.route("**/api/pr/details?**", (route) => route.fulfill({ json: pr }));
    await window.route("**/api/pr/activity?**", (route) => {
      const params = new URL(route.request().url()).searchParams;
      const kind = params.get("kind");
      const page = Number(params.get("page"));
      if (kind === "thread-states") return route.fulfill({ status: 403, json: { error: "Thread metadata unavailable" } });
      if (kind === "threads") return route.fulfill({ json: { items: [{ id: 10, pull_request_review_id: 2, path: "later.ts", body: "Later code discussion" }], hasMore: false } });
      if (page === 2 && fail) return route.fulfill({ status: 503, json: { error: "Timeline temporarily unavailable" } });
      return route.fulfill({ json: { items: page === 1 ? [
        { event: "committed", sha: "a", message: "First change", author: { name: "Author" } },
        { event: "cross-referenced", created_at: "2026-09-08T00:00:00Z", source: { issue: { number: 9, title: "Related work", html_url: "https://github.com/example/project/pull/9", state: "open" } } },
      ] : [{ event: "ready_for_review", id: 1, actor: { login: "author" } }, { event: "reviewed", id: 2, user: { login: "reviewer" }, state: "approved", body: "" }], hasMore: page === 1 } });
    });
    await window.reload();
    await window.getByRole("button", { name: "Open", exact: true }).first().click();
    await window.locator(".picker-form input").fill(repo);
    await window.locator(".picker-form button[type=submit]").click();
    await window.getByRole("button", { name: "All Pull Requests" }).click();
    await window.getByRole("button", { name: "#1 Timeline ordering", exact: true }).click();
    const dialog = window.getByRole("dialog", { name: "Pull request #1", exact: true });
    await expect(dialog.locator(".prv-timeline-entry")).toHaveCount(2);
    await expect(dialog.getByText("Later code discussion")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Load more activity" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Timeline temporarily unavailable");
    await expect(dialog.locator(".prv-timeline-entry")).toHaveCount(2);
    fail = false;
    await dialog.getByRole("button", { name: "Retry conversation" }).click();
    await expect(dialog.locator(".prv-timeline-entry")).toHaveCount(4);
    await expect(dialog.locator(".prv-timeline-entry").nth(0)).toContainText("First change");
    await expect(dialog.locator(".prv-timeline-entry").nth(1)).toContainText("Related work");
    await expect(dialog.locator(".prv-timeline-entry").nth(2)).toContainText("ready for review");
    await expect(dialog.locator(".prv-timeline-entry").nth(3)).toContainText("approved these changes");
    await expect(dialog.locator(".prv-timeline-review")).toContainText("Later code discussion");
    await expect(dialog.getByText(/Thread resolution status unavailable/)).toBeVisible();
    let releaseReply: (() => Promise<void>) | undefined;
    await window.route("**/api/pr/action", async (route) => {
      await new Promise<void>((resolve) => {
        releaseReply = async () => {
          await route.fulfill({ json: { ok: true, reply: { id: 11, in_reply_to_id: 10, user: { login: "viewer" }, body: "Reply survives loading", created_at: "2026-09-08T01:00:00Z" } } });
          resolve();
        };
      });
    });
    await dialog.getByRole("textbox", { name: "Reply to code comment" }).fill("Reply survives loading");
    await dialog.getByRole("button", { name: "Reply", exact: true }).click();
    await expect.poll(() => !!releaseReply).toBe(true);
    await expect(dialog.getByRole("button", { name: "Retry thread status" })).toBeDisabled();
    await releaseReply!();
    await expect(dialog.getByText("Reply survives loading", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Retry thread status" })).toBeEnabled();
  } finally {
    if (started) { await started.app.close(); await cleanupApp(started); }
    await removeRepo(repo);
  }
});
