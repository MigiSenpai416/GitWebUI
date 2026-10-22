import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dispatch, errorMessage, errorStatus } from "./api.js";
import { beginRepoMutation } from "./git/historyFiles.js";
import { openRepo } from "./git/repo.js";
import { runGit } from "./git/gitRunner.js";
import { registerRepo, unregisterRepo } from "./session.js";

const TMP = path.join(os.tmpdir(), `gitwebui-reporoutes-${randomBytes(6).toString("hex")}`);

/** Make one call the way the main process does, JSON round-trip included. */
async function call(route: string, root: string, input: Record<string, unknown> = {}) {
  try {
    const result = await dispatch(route, input, { root, signal: new AbortController().signal });
    return { status: 200, body: JSON.parse(JSON.stringify(result)) };
  } catch (e) {
    return { status: errorStatus(e), body: { error: errorMessage(e) } };
  }
}

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
  await runGit(TMP, ["init", "-b", "main"]);
  await runGit(TMP, ["config", "user.name", "Test User"]);
  await runGit(TMP, ["config", "user.email", "test@example.com"]);
});

afterAll(async () => {
  // Git normalizes the registered root (notably path separators on Windows).
  unregisterRepo((await openRepo(TMP)).root);
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("currentRepo", () => {
  it("re-reads branch metadata changed outside GitWebUI", async () => {
    const opened = registerRepo(await openRepo(TMP));
    expect(opened.branch).toBe("main");

    // Model a branch switch performed in the built-in terminal or another Git
    // client. The registered object still says main until the refresh call is
    // made.
    await runGit(TMP, ["branch", "-m", "outside-change"]);

    const res = await call("currentRepo", opened.root);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      repo: { root: opened.root, branch: "outside-change", head: null },
    });
  });
});

describe("commit", () => {
  it("refreshes an unborn repository so its first commit is immediately listed", async () => {
    const opened = registerRepo(await openRepo(TMP));
    expect(opened.head).toBeNull();
    await fs.writeFile(path.join(TMP, "first.txt"), "first\n", "utf8");
    await runGit(TMP, ["add", "--", "first.txt"]);

    const committed = await call("commit", opened.root, {
      title: "first commit",
      description: "first body",
      amend: false,
    });
    expect(committed.status).toBe(200);
    const result = committed.body as {
      hash: string;
      repo: { head: string | null };
    };
    expect(result.repo.head).toBe(result.hash);

    const listed = await call("commits", opened.root, { skip: 0, limit: 10 });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      commits: [{ hash: result.hash, subject: "first commit", body: "first body" }],
      hasMore: false,
    });
  });

  it("refreshes detached HEAD after amending without moving the branch", async () => {
    const opened = registerRepo(await openRepo(TMP));
    const branch = opened.branch;
    const original = opened.head;
    await runGit(TMP, ["checkout", "--detach", "HEAD"]);
    try {
      const committed = await call("commit", opened.root, { title: "detached amendment", amend: true });
      expect(committed.status).toBe(200);
      const result = committed.body as { hash: string };
      expect(result.hash).not.toBe(original);
      expect(result).toMatchObject({
        repo: { root: opened.root, branch: "HEAD", head: result.hash },
        status: { staged: [], unstaged: [] },
      });
      expect((await runGit(TMP, ["rev-parse", branch])).stdout.trim()).toBe(original);
      const current = await call("currentRepo", opened.root);
      expect(current.body).toMatchObject({
        repo: { branch: "HEAD", head: result.hash },
      });
    } finally {
      await runGit(TMP, ["checkout", branch]);
    }
  });

  it("reads and commits a linked worktree index without changing the main worktree", async () => {
    const main = registerRepo(await openRepo(TMP));
    const linkedPath = path.join(TMP, "linked-worktree");
    await runGit(TMP, ["worktree", "add", "-b", "linked-review", linkedPath, "HEAD"]);
    const linked = registerRepo(await openRepo(linkedPath));
    try {
      await fs.writeFile(path.join(linkedPath, "first.txt"), "staged version\n", "utf8");
      await runGit(linkedPath, ["add", "--", "first.txt"]);
      await fs.writeFile(path.join(linkedPath, "first.txt"), "unstaged version\n", "utf8");
      const status = await call("status", linked.root);
      expect(status.status).toBe(200);
      expect(status.body).toEqual({
        staged: [{ path: "first.txt", status: "M", staged: true }],
        unstaged: [{ path: "first.txt", status: "M", staged: false }],
      });
      const committed = await call("commit", linked.root, { title: "linked staged change" });
      expect(committed.status).toBe(200);
      const result = committed.body as { hash: string };
      expect(result).toMatchObject({
        repo: { root: linked.root, branch: "linked-review", head: result.hash },
        status: { staged: [], unstaged: [{ path: "first.txt", status: "M", staged: false }] },
      });
      expect((await runGit(linkedPath, ["show", "HEAD:first.txt"])).stdout.replace(/\r/g, ""))
        .toBe("staged version\n");
      expect((await runGit(TMP, ["rev-parse", "HEAD"])).stdout.trim()).toBe(main.head);
      expect(await fs.readFile(path.join(TMP, "first.txt"), "utf8")).toBe("first\n");
    } finally {
      unregisterRepo(linked.root);
      await runGit(TMP, ["worktree", "remove", "--force", linkedPath]);
      await runGit(TMP, ["branch", "-D", "linked-review"]);
    }
  });
});

describe("merge", () => {
  it("rejects an unknown merge strategy before running git", async () => {
    const opened = registerRepo(await openRepo(TMP));
    const response = await call("merge", opened.root, { branch: "feature", strategy: "squash" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "A valid merge strategy is required" });
  });
});

describe("pruneRepo", () => {
  it("prunes unreachable Git objects, preserves recovery files, and waits for mutations", async () => {
    const opened = registerRepo(await openRepo(TMP));
    const unreachable = (
      await runGit(TMP, ["hash-object", "-w", "--stdin"], { input: "unreachable object\n" })
    ).stdout.trim();
    const recoveryFile = path.join(
      TMP,
      ".git",
      "gitwebui-history-backups",
      "test-recovery",
      "recovery.bundle",
    );
    await fs.mkdir(path.dirname(recoveryFile), { recursive: true });
    await fs.writeFile(recoveryFile, "keep this recovery file\n");

    const release = beginRepoMutation(opened.root);
    try {
      const busy = await call("pruneRepo", opened.root);
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({
        error: expect.stringContaining("other repository operations"),
      });
    } finally {
      release();
    }

    const pruned = await call("pruneRepo", opened.root);
    expect(pruned.status).toBe(200);
    expect(pruned.body).toEqual({ ok: true });
    await expect(runGit(TMP, ["cat-file", "-e", unreachable])).rejects.toThrow();
    await expect(fs.readFile(recoveryFile, "utf8")).resolves.toBe("keep this recovery file\n");
  });
});

describe("history rewrite mutation reservations", () => {
  it("refuses unknown routes without reserving the repository and exempts history deletion", async () => {
    const opened = registerRepo(await openRepo(TMP));
    const unmatched = await call("not-a-route", opened.root);
    expect(unmatched.status).toBe(404);

    const head = (await runGit(TMP, ["rev-parse", "HEAD"])).stdout.trim();
    const deletion = await call("deleteFromHistory", opened.root, {
      path: "does-not-exist.txt",
      expectedHead: head,
      confirmation: "does-not-exist.txt",
    });
    expect(deletion.status).toBe(409);
    expect(deletion.body).toMatchObject({
      error: expect.stringContaining("no longer exists in reachable history"),
    });
  });
});
