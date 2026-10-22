import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setConfigDir } from "../config.js";
import {
  beginRepoMutation,
  deletePathFromHistory,
  getHeadFileContent,
  getHeadFileTree,
  parseLsTree,
} from "./historyFiles.js";
import { runGit } from "./gitRunner.js";
import { gitPath, hasGitPathOverride, resolveGitPath, setGitPath } from "./gitPath.js";
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

async function hashObject(content: string): Promise<string> {
  return (await runGit(ROOT, ["hash-object", "-w", "--stdin"], { input: content })).stdout.trim();
}

async function makeTree(entries: Array<{ mode: string; type: string; oid: string; name: string }>) {
  const input = Buffer.from(
    `${entries.map((entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.name}`).join("\0")}\0`,
  );
  return (await runGit(ROOT, ["mktree", "-z"], { input })).stdout.trim();
}

describe("HEAD file tree", () => {
  it("returns an empty, usable result for an unborn repository", async () => {
    await expect(getHeadFileTree(ROOT)).resolves.toEqual({
      head: null,
      entries: [],
      historicalPaths: [],
    });
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
    expect(tree.historicalPaths).toEqual([]);
  });

  it("lists paths deleted from HEAD separately from current entries", async () => {
    await fs.writeFile(path.join(ROOT, "a.txt"), "a\n");
    await fs.writeFile(path.join(ROOT, "b.txt"), "b\n");
    await commitAll("add both files");
    await fs.rm(path.join(ROOT, "b.txt"));
    const head = await commitAll("delete b");

    await expect(getHeadFileTree(ROOT)).resolves.toMatchObject({ historicalPaths: [] });
    await expect(getHeadFileTree(ROOT, true)).resolves.toEqual({
      head,
      entries: [
        { path: "a.txt", mode: "100644", kind: "file", size: 2 },
      ],
      historicalPaths: ["b.txt"],
    });
  });

  it("includes paths reachable only from older stash reflog entries", async () => {
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "tracked\n");
    await commitAll("base");
    await fs.writeFile(path.join(ROOT, "old-only.txt"), "old\n");
    await runGit(ROOT, ["stash", "push", "-u", "-m", "older"]);
    await fs.writeFile(path.join(ROOT, "new-only.txt"), "new\n");
    await runGit(ROOT, ["stash", "push", "-u", "-m", "newer"]);

    const tree = await getHeadFileTree(ROOT, true);

    expect(tree.historicalPaths).toEqual(expect.arrayContaining(["new-only.txt", "old-only.txt"]));
  });

  it("preserves a leading UTF-8 BOM as part of a historical filename", async () => {
    const target = "\uFEFFname.txt";
    await fs.writeFile(path.join(ROOT, target), "bom name\n");
    await commitAll("BOM filename");
    await fs.rm(path.join(ROOT, target));
    await commitAll("remove BOM filename");

    expect((await getHeadFileTree(ROOT, true)).historicalPaths).toContain(target);
  });

  it("rejects non-UTF-8 historical paths instead of exposing a lossy selection", async () => {
    const invalidBlob = await hashObject("invalid\n");
    const invalidTree = (
      await runGit(ROOT, ["mktree", "-z"], {
        input: Buffer.concat([
          Buffer.from(`100644 blob ${invalidBlob}\tbad-`),
          Buffer.from([0xff]),
          Buffer.from(".txt\0"),
        ]),
      })
    ).stdout.trim();
    const original = (
      await runGit(ROOT, ["commit-tree", invalidTree], { input: "invalid filename\n" })
    ).stdout.trim();
    const keepBlob = await hashObject("keep\n");
    const currentTree = await makeTree([
      { mode: "100644", type: "blob", oid: keepBlob, name: "keep.txt" },
    ]);
    const head = (
      await runGit(ROOT, ["commit-tree", currentTree, "-p", original], { input: "remove invalid\n" })
    ).stdout.trim();
    await runGit(ROOT, ["update-ref", "refs/heads/main", head]);
    await runGit(ROOT, ["reset", "--hard", head]);

    await expect(getHeadFileTree(ROOT, true)).rejects.toThrow("not valid UTF-8");
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

describe("HEAD file content", () => {
  it("reads the exact snapshot rather than the working-tree file", async () => {
    const target = "odd [x] '$file.txt";
    await fs.writeFile(path.join(ROOT, target), "committed\n");
    const head = await commitAll("file");
    await fs.writeFile(path.join(ROOT, target), "working tree\n");

    await expect(getHeadFileContent(ROOT, target, head)).resolves.toMatchObject({
      path: target,
      head,
      content: "committed\n",
      binary: false,
      tooLarge: false,
    });
  });

  it("reads Git tree paths that are not valid Windows working-tree paths", async () => {
    const target = "folder\\file.txt";
    const blob = await hashObject("tree-only\n");
    const tree = await makeTree([{ mode: "100644", type: "blob", oid: blob, name: target }]);
    const head = (await runGit(ROOT, ["commit-tree", tree, "-m", "tree-only file"])).stdout.trim();
    await runGit(ROOT, ["update-ref", "refs/heads/main", head]);

    await expect(getHeadFileTree(ROOT)).resolves.toMatchObject({
      head,
      entries: [{ path: target }],
    });
    await expect(getHeadFileContent(ROOT, target, head)).resolves.toMatchObject({
      path: target,
      content: "tree-only\n",
      binary: false,
      tooLarge: false,
    });
  });

  it("reads a small current blob without generating its large parent diff", async () => {
    const target = "large-parent.txt";
    await fs.writeFile(path.join(ROOT, target), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    const largeHead = await commitAll("large file");
    await fs.writeFile(path.join(ROOT, target), "small now\n");
    const smallHead = await commitAll("small file");

    await expect(getHeadFileContent(ROOT, target, largeHead)).resolves.toMatchObject({
      content: null,
      binary: false,
      tooLarge: true,
      size: 10 * 1024 * 1024 + 1,
    });
    await expect(getHeadFileContent(ROOT, target, smallHead)).resolves.toMatchObject({
      content: "small now\n",
      binary: false,
      tooLarge: false,
      size: 10,
    });
  });

  it("reports binary blobs without sending their content", async () => {
    const target = "binary.bin";
    await fs.writeFile(path.join(ROOT, target), Buffer.from([0x00, 0x01, 0x02]));
    const head = await commitAll("binary file");

    await expect(getHeadFileContent(ROOT, target, head)).resolves.toMatchObject({
      content: null,
      binary: true,
      tooLarge: false,
      size: 3,
    });
  });
});

describe("deletePathFromHistory", () => {
  it("deletes multiple exact file paths in one rewrite across a rename", async () => {
    await fs.writeFile(path.join(ROOT, "a.txt"), "first version\n");
    await fs.writeFile(path.join(ROOT, "other.txt"), "other secret\n");
    await fs.writeFile(path.join(ROOT, "keep.txt"), "keep\n");
    await commitAll("add files");
    await fs.writeFile(path.join(ROOT, "a.txt"), "second version\n");
    await commitAll("edit a");
    await runGit(ROOT, ["mv", "a.txt", "aaa.txt"]);
    const head = await commitAll("rename a");

    const result = await deletePathFromHistory(ROOT, {
      paths: ["a.txt", "aaa.txt", "other.txt"],
      expectedHead: head,
      confirmation: "DELETE 3 FILES",
      recursive: false,
    });

    expect(result.path).toBe("a.txt");
    expect(result.paths).toEqual(["a.txt", "aaa.txt", "other.txt"]);
    expect((await runGit(ROOT, ["log", "--all", "--format=%H", "--", "a.txt", "aaa.txt", "other.txt"])).stdout.trim()).toBe("");
    expect((await runGit(ROOT, ["show", "HEAD:keep.txt"])).stdout).toBe("keep\n");
    await expect(fs.access(path.join(ROOT, "aaa.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(ROOT, "other.txt"))).rejects.toThrow();
    const manifest = JSON.parse(
      await fs.readFile(path.join(result.worktreeBackupPath, "paths.json"), "utf8"),
    ) as Array<{ target: string; backup: string }>;
    expect(manifest).toEqual([
      { target: "aaa.txt", backup: "001" },
      { target: "other.txt", backup: "002" },
    ]);
    expect(await fs.readFile(path.join(result.worktreeBackupPath, "001"), "utf8")).toBe("second version\n");
    expect(await fs.readFile(path.join(result.worktreeBackupPath, "002"), "utf8")).toBe("other secret\n");
    expect((await getHeadFileTree(ROOT, true)).historicalPaths).toEqual([]);
  }, 30_000);

  it("deletes an exact historical file without removing a current directory at the same path", async () => {
    await fs.writeFile(path.join(ROOT, "shape"), "historical file\n");
    await commitAll("shape is a file");
    await fs.rm(path.join(ROOT, "shape"));
    await fs.mkdir(path.join(ROOT, "shape"));
    await fs.writeFile(path.join(ROOT, "shape", "keep.txt"), "keep\n");
    const head = await commitAll("shape becomes a directory");

    const result = await deletePathFromHistory(ROOT, {
      paths: ["shape"],
      expectedHead: head,
      confirmation: "shape",
    });

    expect(result.worktreeBackupPath).toBe("");
    expect(await fs.readFile(path.join(ROOT, "shape", "keep.txt"), "utf8")).toBe("keep\n");
    expect((await runGit(ROOT, ["show", "HEAD:shape/keep.txt"])).stdout).toBe("keep\n");
    expect((await runGit(ROOT, ["ls-files", "--error-unmatch", "shape/keep.txt"])).stdout.trim()).toBe("shape/keep.txt");
    const tree = await getHeadFileTree(ROOT, true);
    expect(tree.historicalPaths).not.toContain("shape");
    expect(tree.entries.map((entry) => entry.path)).toContain("shape/keep.txt");
  }, 30_000);

  it("deletes a path reachable only from an older stash entry", async () => {
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "tracked\n");
    const head = await commitAll("base");
    await fs.writeFile(path.join(ROOT, "old-only.txt"), "old\n");
    await runGit(ROOT, ["stash", "push", "-u", "-m", "older"]);
    await fs.writeFile(path.join(ROOT, "new-only.txt"), "new\n");
    await runGit(ROOT, ["stash", "push", "-u", "-m", "newer"]);

    await deletePathFromHistory(ROOT, {
      path: "old-only.txt",
      expectedHead: head,
      confirmation: "old-only.txt",
      recursive: false,
    });

    const paths = (await getHeadFileTree(ROOT, true)).historicalPaths;
    expect(paths).not.toContain("old-only.txt");
    expect(paths).toContain("new-only.txt");
    expect(await getStashes(ROOT)).toHaveLength(2);
  }, 30_000);

  it("deletes a history-only Git path containing a literal backslash", async () => {
    const target = "old\\name.txt";
    const secret = await hashObject("secret\n");
    const keep = await hashObject("keep\n");
    const originalTree = await makeTree([
      { mode: "100644", type: "blob", oid: secret, name: target },
      { mode: "100644", type: "blob", oid: keep, name: "keep.txt" },
    ]);
    const original = (
      await runGit(ROOT, ["commit-tree", originalTree], { input: "backslash path\n" })
    ).stdout.trim();
    const currentTree = await makeTree([
      { mode: "100644", type: "blob", oid: keep, name: "keep.txt" },
    ]);
    const head = (
      await runGit(ROOT, ["commit-tree", currentTree, "-p", original], { input: "remove path\n" })
    ).stdout.trim();
    await runGit(ROOT, ["update-ref", "refs/heads/main", head]);
    await runGit(ROOT, ["reset", "--hard", head]);
    expect((await getHeadFileTree(ROOT, true)).historicalPaths).toContain(target);

    await deletePathFromHistory(ROOT, {
      path: target,
      expectedHead: head,
      confirmation: target,
      recursive: false,
    });

    expect((await getHeadFileTree(ROOT, true)).historicalPaths).not.toContain(target);
    expect((await runGit(ROOT, ["show", "HEAD:keep.txt"])).stdout).toBe("keep\n");
  }, 30_000);

  it("removes a path that was deleted from HEAD but remains in reachable history", async () => {
    await fs.writeFile(path.join(ROOT, "a.txt"), "keep\n");
    await fs.writeFile(path.join(ROOT, "b.txt"), "remove\n");
    await commitAll("add both files");
    await fs.rm(path.join(ROOT, "b.txt"));
    const head = await commitAll("delete b");

    const result = await deletePathFromHistory(ROOT, {
      path: "b.txt",
      expectedHead: head,
      confirmation: "b.txt",
    });

    expect(result.worktreeBackupPath).toBe("");
    await expect(fs.stat(result.indexBackupPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect((await runGit(ROOT, ["log", "--all", "--format=%H", "--", ":(literal)b.txt"])).stdout.trim()).toBe("");
    expect((await runGit(ROOT, ["show", "HEAD:a.txt"])).stdout).toBe("keep\n");
    await expect(getHeadFileTree(ROOT, true)).resolves.toMatchObject({ historicalPaths: [] });
  }, 30_000);

  it("removes an exact file path from every branch, tag, remote-tracking ref, and stash", async () => {
    const target = "odd [x] '$file.txt";
    await fs.writeFile(path.join(ROOT, "keep.txt"), "keep\n");
    await fs.writeFile(path.join(ROOT, target), "secret one\n");
    const oldHead = await commitAll("add secret");
    await runGit(ROOT, ["tag", "-a", "secret-tag", "-m", "tag before rewrite"]);
    await runGit(ROOT, ["tag", "-a", "nested-secret-tag", "-m", "nested tag", "secret-tag"]);
    await runGit(ROOT, ["branch", "side"]);
    await runGit(ROOT, ["update-ref", "refs/remotes/origin/main", oldHead]);
    await runGit(ROOT, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await runGit(ROOT, [
      "update-ref",
      "--create-reflog",
      "-m",
      "custom recovery route",
      "refs/custom/name@part",
      oldHead,
    ]);
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
    expect((await runGit(ROOT, ["cat-file", "-t", "nested-secret-tag"])).stdout.trim()).toBe("tag");
    expect(
      (await runGit(ROOT, ["reflog", "show", "--format=%H", "refs/custom/name@part"])).stdout.trim(),
    ).toBe("");
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

  it("does not treat an internal Git-notes tree path as retained user history", async () => {
    await fs.writeFile(path.join(ROOT, "keep.txt"), "keep\n");
    const annotated = await commitAll("base");
    await runGit(ROOT, ["notes", "--ref=commits", "add", "-m", "keep this note", annotated]);
    await fs.writeFile(path.join(ROOT, annotated), "secret\n");
    const head = await commitAll("user file collides with note path");
    const notesBefore = (await runGit(ROOT, ["rev-parse", "refs/notes/commits"])).stdout.trim();

    await deletePathFromHistory(ROOT, {
      path: annotated,
      expectedHead: head,
      confirmation: annotated,
      recursive: false,
    });

    expect((await runGit(ROOT, ["log", "--exclude=refs/notes/*", "--all", "--format=%H", "--", `:(literal)${annotated}`])).stdout.trim()).toBe("");
    expect((await runGit(ROOT, ["rev-parse", "refs/notes/commits"])).stdout.trim()).toBe(notesBefore);
    expect((await runGit(ROOT, ["notes", "--ref=commits", "show", annotated])).stdout).toBe("keep this note\n");
    expect((await runGit(ROOT, ["show", "HEAD:keep.txt"])).stdout).toBe("keep\n");
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
      paths: ["private"],
      expectedHead: oldHead,
      confirmation: "private",
      recursive: true,
    });

    expect((await runGit(ROOT, ["log", "--all", "--format=%H", "--", ":(literal)private"])).stdout.trim()).toBe("");
    expect((await runGit(ROOT, ["show", "HEAD:public.txt"])).stdout).toContain("public");
    await expect(fs.access(path.join(ROOT, "private"))).rejects.toThrow();
  }, 30_000);

  it("removes a path that begins with an option-like dash", async () => {
    const target = "--help";
    await fs.writeFile(path.join(ROOT, target), "secret\n");
    await fs.writeFile(path.join(ROOT, "keep.txt"), "keep\n");
    const head = await commitAll("option-like path");

    await deletePathFromHistory(ROOT, {
      path: target,
      expectedHead: head,
      confirmation: target,
    });

    expect(
      (await runGit(ROOT, ["log", "--all", "--format=%H", "--", `:(literal)${target}`])).stdout.trim(),
    ).toBe("");
    expect((await runGit(ROOT, ["show", "HEAD:keep.txt"])).stdout).toContain("keep");
  }, 30_000);

  it("does not rewrite old commit hashes mentioned in commit messages", async () => {
    await fs.writeFile(path.join(ROOT, "secret.txt"), "secret\n");
    await fs.writeFile(path.join(ROOT, "keep.txt"), "one\n");
    const referenced = await commitAll("secret");
    await fs.writeFile(path.join(ROOT, "keep.txt"), "two\n");
    const head = await commitAll(`keep references ${referenced}`);

    await deletePathFromHistory(ROOT, {
      path: "secret.txt",
      expectedHead: head,
      confirmation: "secret.txt",
    });

    expect((await runGit(ROOT, ["log", "-1", "--format=%B"])).stdout).toContain(referenced);
  }, 30_000);

  it("preserves unrelated Windows-incompatible historical paths in the isolated mirror", async () => {
    const empty = await hashObject("");
    const secret = await hashObject("secret\n");
    const keep = await hashObject("keep\n");
    const invalidTree = await makeTree([{ mode: "100644", type: "blob", oid: empty, name: ">" }]);
    const sdkTree = await makeTree([{ mode: "100644", type: "blob", oid: secret, name: "x" }]);
    const originalTree = await makeTree([
      { mode: "040000", type: "tree", oid: invalidTree, name: "codex-cli" },
      { mode: "100644", type: "blob", oid: keep, name: "keep.txt" },
      { mode: "040000", type: "tree", oid: sdkTree, name: "sdk" },
    ]);
    const original = (
      await runGit(ROOT, ["commit-tree", originalTree], { input: "historical invalid path\n" })
    ).stdout.trim();
    const currentTree = await makeTree([
      { mode: "100644", type: "blob", oid: keep, name: "keep.txt" },
      { mode: "040000", type: "tree", oid: sdkTree, name: "sdk" },
    ]);
    const head = (
      await runGit(ROOT, ["commit-tree", currentTree, "-p", original], {
        input: "remove invalid path\n",
      })
    ).stdout.trim();
    await runGit(ROOT, ["update-ref", "refs/heads/main", head]);
    await runGit(ROOT, ["reset", "--hard", head]);
    await runGit(ROOT, ["config", "core.protectNTFS", "true"]);
    await runGit(ROOT, ["config", "core.protectHFS", "true"]);

    await deletePathFromHistory(ROOT, {
      path: "sdk",
      expectedHead: head,
      confirmation: "sdk",
    });

    expect((await runGit(ROOT, ["log", "--all", "--format=%H", "--", ":(literal)sdk"])).stdout.trim()).toBe("");
    const rewrittenOriginal = (
      await runGit(ROOT, ["rev-list", "--reverse", "HEAD"])
    ).stdout.trim().split(/\r?\n/)[0];
    expect(
      (await runGit(ROOT, ["ls-tree", "-r", "--name-only", rewrittenOriginal])).stdout,
    ).toContain("codex-cli/>");
    expect((await runGit(ROOT, ["config", "--bool", "core.protectNTFS"])).stdout.trim()).toBe("true");
    expect((await runGit(ROOT, ["config", "--bool", "core.protectHFS"])).stdout.trim()).toBe("true");
  }, 30_000);

  it("rewrites hundreds of packed commit refs through one bounded import", async () => {
    await fs.writeFile(path.join(ROOT, "secret.txt"), "secret\n");
    await fs.writeFile(path.join(ROOT, "keep.txt"), "keep\n");
    const head = await commitAll("many refs");
    const commands = ["start"];
    for (let index = 0; index < 96; index++) {
      const suffix = String(index).padStart(3, "0");
      commands.push(`update refs/heads/load/${suffix} ${head}`);
      commands.push(`update refs/remotes/origin/load/${suffix} ${head}`);
    }
    const longRef = `refs/remotes/origin/${"long-segment-".repeat(8)}tip`;
    commands.push(`update ${longRef} ${head}`, "prepare", "commit", "");
    await runGit(ROOT, ["update-ref", "--stdin"], { input: commands.join("\n") });
    await runGit(ROOT, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/load/000",
    ]);
    await runGit(ROOT, ["tag", "-a", "load-tag", "-m", "load tag"]);
    await runGit(ROOT, ["tag", "-a", "nested-load-tag", "-m", "nested load tag", "load-tag"]);
    await runGit(ROOT, ["pack-refs", "--all"]);
    const refsBefore = (
      await runGit(ROOT, ["for-each-ref", "--format=%(refname)"])
    ).stdout.trim().split(/\r?\n/).length;

    await deletePathFromHistory(ROOT, {
      path: "secret.txt",
      expectedHead: head,
      confirmation: "secret.txt",
    });

    const refsAfter = (
      await runGit(ROOT, ["for-each-ref", "--format=%(refname)"])
    ).stdout.trim().split(/\r?\n/).length;
    expect(refsAfter).toBe(refsBefore);
    expect((await runGit(ROOT, ["symbolic-ref", "refs/remotes/origin/HEAD"])).stdout.trim()).toBe(
      "refs/remotes/origin/load/000",
    );
    expect((await runGit(ROOT, ["rev-parse", "--verify", longRef])).stdout.trim()).not.toBe(head);
    expect((await runGit(ROOT, ["cat-file", "-t", "nested-load-tag"])).stdout.trim()).toBe("tag");
    expect((await runGit(ROOT, ["log", "--all", "--format=%H", "--", "secret.txt"])).stdout.trim()).toBe("");
  }, 45_000);

  it("fails with installation guidance before creating recovery artifacts", async () => {
    await fs.writeFile(path.join(ROOT, "secret.txt"), "secret\n");
    const head = await commitAll("secret");
    const emptyPath = path.join(BASE, "empty-path");
    await fs.mkdir(emptyPath);
    const previousGitPath = gitPath();
    const previousGitPathOverride = hasGitPathOverride();
    const previousPath = process.env.PATH;
    const previousExecPath = process.env.GIT_EXEC_PATH;
    const executable = path.isAbsolute(previousGitPath)
      ? previousGitPath
      : await resolveGitPath();
    if (!executable) throw new Error("The history rewrite test requires git");

    try {
      setGitPath(executable);
      process.env.PATH = emptyPath;
      process.env.GIT_EXEC_PATH = emptyPath;
      await expect(
        deletePathFromHistory(ROOT, {
          path: "secret.txt",
          expectedHead: head,
          confirmation: "secret.txt",
        }),
      ).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("pipx install git-filter-repo"),
      });
      await expect(
        deletePathFromHistory(ROOT, {
          path: "secret.txt",
          expectedHead: head,
          confirmation: "secret.txt",
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("git filter-repo --version"),
      });
      await expect(fs.readdir(path.join(CONFIG, "history-backups"))).rejects.toThrow();
    } finally {
      setGitPath(previousGitPathOverride ? previousGitPath : null);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousExecPath === undefined) delete process.env.GIT_EXEC_PATH;
      else process.env.GIT_EXEC_PATH = previousExecPath;
    }
    expect((await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(await fs.readFile(path.join(ROOT, "secret.txt"), "utf8")).toBe("secret\n");
    expect(
      (await runGit(ROOT, ["for-each-ref", "--format=%(refname)", "refs/gitwebui-history-rewrite"])).stdout.trim(),
    ).toBe("");
  });

  it("rejects SHA-256 repositories before creating recovery artifacts", async () => {
    const sha256Root = path.join(BASE, "sha256");
    await fs.mkdir(sha256Root);
    await runGit(sha256Root, ["init", "--object-format=sha256", "-b", "main"]);
    await runGit(sha256Root, ["config", "user.name", "History Tester"]);
    await runGit(sha256Root, ["config", "user.email", "history@example.com"]);
    await fs.writeFile(path.join(sha256Root, "secret.txt"), "secret\n");
    await runGit(sha256Root, ["add", "-A"]);
    await runGit(sha256Root, ["commit", "-m", "secret"]);
    const head = (await runGit(sha256Root, ["rev-parse", "HEAD"])).stdout.trim();

    await expect(
      deletePathFromHistory(sha256Root, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("SHA-1 repositories"),
    });
    expect((await runGit(sha256Root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(await fs.readFile(path.join(sha256Root, "secret.txt"), "utf8")).toBe("secret\n");
    await expect(fs.readdir(path.join(CONFIG, "history-backups"))).rejects.toThrow();
  });

  it("distinguishes a missing Git executable from missing git-filter-repo", async () => {
    await fs.writeFile(path.join(ROOT, "secret.txt"), "secret\n");
    const head = await commitAll("secret");
    const previousGitPath = gitPath();
    const previousGitPathOverride = hasGitPathOverride();

    try {
      setGitPath(path.join(BASE, "missing-git"));
      await expect(
        deletePathFromHistory(ROOT, {
          path: "secret.txt",
          expectedHead: head,
          confirmation: "secret.txt",
        }),
      ).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("configured Git executable"),
      });
    } finally {
      setGitPath(previousGitPathOverride ? previousGitPath : null);
    }
    await expect(fs.readdir(path.join(CONFIG, "history-backups"))).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")(
    "rejects case-colliding retained and selected paths before moving Windows worktree entries",
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

      await expect(
        deletePathFromHistory(ROOT, {
          paths: ["Foo.txt", "foo.txt"],
          expectedHead: head,
          confirmation: "DELETE 2 FILES",
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
        paths: ["secret.txt", "secret.txt"],
        expectedHead: head,
        confirmation: "DELETE 2 FILES",
        recursive: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deletePathFromHistory(ROOT, {
        paths: ["secret.txt", "other.txt"],
        expectedHead: head,
        confirmation: "DELETE 2 FILES",
        recursive: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deletePathFromHistory(ROOT, {
        paths: ["secret.txt", "other.txt"],
        expectedHead: head,
        confirmation: "secret.txt",
        recursive: false,
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
    await runGit(ROOT, ["tag", "-a", "tree-tip", "-m", "tree tag", tree]);
    await expect(
      deletePathFromHistory(ROOT, {
        path: "secret.txt",
        expectedHead: head,
        confirmation: "secret.txt",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("refs/tags/tree-tip"),
    });
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
  }, 30_000);
});
