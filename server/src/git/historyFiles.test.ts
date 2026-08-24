import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setConfigDir } from "../config.js";
import {
  beginRepoMutation,
  deletePathFromHistory,
  getHeadFileTree,
  parseLsTree,
} from "./historyFiles.js";
import { runGit } from "./gitRunner.js";
import { getStashes, setStashNote } from "./stash.js";

const BASE = path.join(os.tmpdir(), `gitwebui-history-files-${randomBytes(6).toString("hex")}`);
const ROOT = path.join(BASE, "repo");
const CONFIG = path.join(BASE, "config");

beforeEach(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  setConfigDir(CONFIG);
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "user.name", "History Tester"]);
  await runGit(ROOT, ["config", "user.email", "history@example.com"]);
});

afterAll(async () => {
  setConfigDir(null);
  await fs.rm(BASE, { recursive: true, force: true });
});

async function commitAll(message: string): Promise<string> {
  await runGit(ROOT, ["add", "-A"]);
  await runGit(ROOT, ["commit", "-m", message]);
  return (await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("HEAD file tree", () => {
  it("returns an empty, usable result for an unborn repository", async () => {
    await expect(getHeadFileTree(ROOT)).resolves.toEqual({ head: null, entries: [] });
  });

  it("lists nested files from HEAD rather than untracked working-tree files", async () => {
    await fs.mkdir(path.join(ROOT, "docs", "nested"), { recursive: true });
    await fs.writeFile(path.join(ROOT, "README.md"), "hello\n");
    await fs.writeFile(path.join(ROOT, "docs", "nested", "guide.txt"), "guide\n");
    const head = await commitAll("files");
    await fs.writeFile(path.join(ROOT, "not-in-head.txt"), "untracked\n");

    const tree = await getHeadFileTree(ROOT);

    expect(tree.head).toBe(head);
    expect(tree.entries.map((entry) => entry.path)).toEqual([
      "README.md",
      "docs/nested/guide.txt",
    ]);
    expect(tree.entries.every((entry) => entry.kind === "file")).toBe(true);
  });

  it("parses symlink and submodule modes without treating their sizes as numbers", () => {
    expect(
      parseLsTree(
        "120000 blob aaaa 7\tlink\0" +
          "160000 commit bbbb -\tvendor/lib\0" +
          "100644 blob cccc 12\tfile.txt\0",
      ),
    ).toEqual([
      { path: "link", mode: "120000", kind: "symlink", size: 7 },
      { path: "vendor/lib", mode: "160000", kind: "submodule", size: null },
      { path: "file.txt", mode: "100644", kind: "file", size: 12 },
    ]);
  });
});

describe("deletePathFromHistory", () => {
  it("removes an exact file path from every branch, tag, remote-tracking ref, and stash", async () => {
    const target = "odd [x] '$file.txt";
    await fs.writeFile(path.join(ROOT, "keep.txt"), "keep\n");
    await fs.writeFile(path.join(ROOT, target), "secret one\n");
    const oldHead = await commitAll("add secret");
    await runGit(ROOT, ["tag", "-a", "secret-tag", "-m", "tag before rewrite"]);
    await runGit(ROOT, ["branch", "side"]);
    await runGit(ROOT, ["update-ref", "refs/remotes/origin/main", oldHead]);
    await runGit(ROOT, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await runGit(ROOT, ["fetch", ".", "HEAD"]);
    await fs.writeFile(path.join(ROOT, target), "secret stashed\n");
    await runGit(ROOT, ["stash", "push", "-m", "secret stash"]);
    const originalStash = (await runGit(ROOT, ["rev-parse", "refs/stash"])).stdout.trim();
    await setStashNote(ROOT, originalStash, {
      title: "Important note",
      description: "Keep this with the rewritten stash.",
      identity: { name: "History Tester", email: "history@example.com" },
    });

    const result = await deletePathFromHistory(ROOT, {
      path: target,
      expectedHead: oldHead,
      confirmation: target,
    });

    expect(result.path).toBe(target);
    expect(result.rewrittenRefs).toBeGreaterThanOrEqual(4);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain("pre-rewrite index were preserved");
    expect(result.warnings[1]).toContain("Unreachable pre-rewrite Git objects may remain");
    expect(result.warnings[2]).toContain("Non-stash reflogs were cleared");
    await expect(fs.stat(result.backupPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(await fs.readFile(result.worktreeBackupPath, "utf8")).toContain("secret one");
    expect(
      (
        await runGit(ROOT, ["ls-files", "-s", "--", `:(literal)${target}`], {
          env: { GIT_INDEX_FILE: result.indexBackupPath },
        })
      ).stdout,
    ).toContain(target);
    expect((await runGit(ROOT, ["log", "--all", "--format=%H", "--", `:(literal)${target}`])).stdout.trim()).toBe("");
    expect((await runGit(ROOT, ["show", "HEAD:keep.txt"])).stdout).toContain("keep");
    expect(
      (await runGit(ROOT, ["ls-tree", "-z", "HEAD", "--", `:(literal)${target}`])).stdout,
    ).toBe("");
    expect((await runGit(ROOT, ["for-each-ref", "--format=%(refname)", "refs/original"])).stdout.trim()).toBe("");
    expect((await runGit(ROOT, ["symbolic-ref", "refs/remotes/origin/HEAD"])).stdout.trim()).toBe("refs/remotes/origin/main");
    await expect(fs.access(path.join(ROOT, ".git", "FETCH_HEAD"))).rejects.toThrow();
    expect((await runGit(ROOT, ["stash", "list", "--format=%gs"])).stdout.trim()).toContain("secret stash");
    await expect(getStashes(ROOT)).resolves.toEqual([
      expect.objectContaining({ noteTitle: "Important note", noteBody: "Keep this with the rewritten stash." }),
    ]);
    await runGit(ROOT, ["bundle", "verify", result.backupPath]);

    // The deliberate external recovery bundle still contains the old graph.
    const recovered = path.join(BASE, "recovered.git");
    await runGit(BASE, ["init", "--bare", recovered]);
    await runGit(BASE, ["--git-dir", recovered, "fetch", result.backupPath, `${oldHead}:refs/heads/recovered`]);
    expect((await runGit(BASE, ["--git-dir", recovered, "show", `${oldHead}:${target}`])).stdout).toContain("secret one");
  }, 30_000);

  it("preserves a valid empty HEAD and target-only orphan branch instead of deleting refs", async () => {
    await fs.writeFile(path.join(ROOT, "index-before"), "main secret\n");
    const head = await commitAll("main secret only");
    await runGit(ROOT, ["checkout", "--orphan", "only-secret"]);
    await runGit(ROOT, ["rm", "-r", "--cached", "."]);
    await fs.rm(path.join(ROOT, "index-before"));
    await fs.writeFile(path.join(ROOT, "index-before"), "orphan secret\n");
    await commitAll("orphan secret only");
    await runGit(ROOT, ["checkout", "main"]);

    await deletePathFromHistory(ROOT, {
      path: "index-before",
      expectedHead: head,
      confirmation: "index-before",
    });

    expect((await runGit(ROOT, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
    expect((await runGit(ROOT, ["ls-tree", "-r", "--name-only", "HEAD"])).stdout.trim()).toBe("");
    expect((await runGit(ROOT, ["show-ref", "--verify", "refs/heads/only-secret"])).stdout).toContain("only-secret");
    expect((await runGit(ROOT, ["ls-tree", "-r", "--name-only", "only-secret"])).stdout.trim()).toBe("");
  }, 30_000);

  it("includes unrelated reflog-only commits in the verified recovery bundle", async () => {
    await fs.writeFile(path.join(ROOT, "secret.txt"), "secret\n");
    await fs.writeFile(path.join(ROOT, "keep.txt"), "base\n");
    await commitAll("base with secret");
    await fs.writeFile(path.join(ROOT, "keep.txt"), "recover me\n");
    const recoverable = await commitAll("reflog-only work");
    await runGit(ROOT, ["reset", "--hard", "HEAD^"]);
    const head = (await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim();

    const result = await deletePathFromHistory(ROOT, {
      path: "secret.txt",
      expectedHead: head,
      confirmation: "secret.txt",
    });

    const advertised = (await runGit(ROOT, ["bundle", "list-heads", result.backupPath])).stdout;
    const recoveryRef = advertised.trim().split(/\s+/)[1];
    expect(recoveryRef).toContain("recovery-root");
    const recovered = path.join(BASE, "reflog-recovered.git");
    await runGit(BASE, ["init", "--bare", recovered]);
    await runGit(BASE, [
      "--git-dir",
      recovered,
      "fetch",
      result.backupPath,
      `${recoveryRef}:refs/heads/recovery`,
    ]);
    expect((await runGit(BASE, ["--git-dir", recovered, "cat-file", "-t", recoverable])).stdout.trim()).toBe("commit");
    // No eager global prune: unrelated dangling objects also remain locally
    // until normal Git maintenance, while the selected path is gone from refs.
    expect((await runGit(ROOT, ["cat-file", "-t", recoverable])).stdout.trim()).toBe("commit");
    expect((await runGit(ROOT, ["reflog", "show", "--all", "--format=%H"])).stdout).not.toContain(recoverable);
  }, 30_000);

  it("recursively removes a directory even when its historical shape changes", async () => {
    await fs.mkdir(path.join(ROOT, "private", "nested"), { recursive: true });
    await fs.writeFile(path.join(ROOT, "private", "one.txt"), "one\n");
    await fs.writeFile(path.join(ROOT, "private", "nested", "two.txt"), "two\n");
    await fs.writeFile(path.join(ROOT, "public.txt"), "public\n");
    await commitAll("directory");
    await fs.rm(path.join(ROOT, "private"), { recursive: true });
    await fs.writeFile(path.join(ROOT, "private"), "now a file\n");
    const oldHead = await commitAll("directory becomes a file");

    await deletePathFromHistory(ROOT, {
      path: "private",
      expectedHead: oldHead,
      confirmation: "private",
    });

    expect((await runGit(ROOT, ["log", "--all", "--format=%H", "--", ":(literal)private"])).stdout.trim()).toBe("");
    expect((await runGit(ROOT, ["show", "HEAD:public.txt"])).stdout).toContain("public");
    await expect(fs.access(path.join(ROOT, "private"))).rejects.toThrow();
  }, 30_000);

  it.skipIf(process.platform !== "win32")(
    "rejects case-colliding retained paths before moving the Windows worktree entry",
    async () => {
      await fs.writeFile(path.join(ROOT, "Foo.txt"), "same content\n");
      await commitAll("case source");
      const blob = (await runGit(ROOT, ["rev-parse", "HEAD:Foo.txt"])).stdout.trim();
      await runGit(ROOT, ["update-index", "--add", "--cacheinfo", "100644", blob, "foo.txt"]);
      await runGit(ROOT, ["commit", "-m", "case collision"]);
      const head = (await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim();
      expect((await runGit(ROOT, ["ls-files"])).stdout).toContain("Foo.txt\nfoo.txt");

      await expect(
        deletePathFromHistory(ROOT, {
          path: "Foo.txt",
          expectedHead: head,
          confirmation: "Foo.txt",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
      expect(await fs.readFile(path.join(ROOT, "Foo.txt"), "utf8")).toBe("same content\n");
    },
  );

  it("rejects stale, dirty, linked-worktree, traversal, and mismatched-confirmation requests", async () => {
    await fs.writeFile(path.join(ROOT, "secret.txt"), "secret\n");
    const head = await commitAll("secret");

    await expect(
      deletePathFromHistory(ROOT, {
        path: "../secret.txt",
        expectedHead: head,
        confirmation: "../secret.txt",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "DELETE",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: "0".repeat(40),
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await runGit(ROOT, ["checkout", "--detach", head]);
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await runGit(ROOT, ["checkout", "main"]);

    await runGit(ROOT, ["update-index", "--assume-unchanged", "secret.txt"]);
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await runGit(ROOT, ["update-index", "--no-assume-unchanged", "secret.txt"]);

    await runGit(ROOT, ["update-index", "--skip-worktree", "secret.txt"]);
    const backupsBeforeSkip = await fs
      .readdir(path.join(CONFIG, "history-backups"))
      .catch(() => [] as string[]);
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await fs.readdir(path.join(CONFIG, "history-backups")).catch(() => [] as string[]),
    ).toEqual(backupsBeforeSkip);
    await runGit(ROOT, ["update-index", "--no-skip-worktree", "secret.txt"]);

    const releaseMutation = beginRepoMutation(ROOT);
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({ status: 409 });
    releaseMutation();

    const tree = (await runGit(ROOT, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    await runGit(ROOT, ["update-ref", "refs/tags/tree-tip", tree]);
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await runGit(ROOT, ["update-ref", "-d", "refs/tags/tree-tip"]);

    await fs.writeFile(path.join(ROOT, "untracked.txt"), "work\n");
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await fs.rm(path.join(ROOT, "untracked.txt"));

    const linked = path.join(BASE, "linked");
    await runGit(ROOT, ["worktree", "add", "-b", "linked-branch", linked]);
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
  });
});
