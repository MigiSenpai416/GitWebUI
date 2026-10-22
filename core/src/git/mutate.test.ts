import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  commit,
  deleteFile,
  discardPaths,
  stageAll,
  stagePaths,
  unstagePaths,
} from "./mutate.js";
import { getStatus } from "./status.js";
import { runGit } from "./gitRunner.js";

const ROOT = path.join(os.tmpdir(), `gitwebui-mutate-${randomBytes(6).toString("hex")}`);

beforeEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, "sub"), { recursive: true });
});
afterAll(() => fs.rm(ROOT, { recursive: true, force: true }));

async function initRepo(): Promise<void> {
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "user.name", "Configured User"]);
  await runGit(ROOT, ["config", "user.email", "configured@example.com"]);
  await fs.writeFile(path.join(ROOT, "tracked.txt"), "base\n", "utf8");
  await runGit(ROOT, ["add", "--", "tracked.txt"]);
  await runGit(ROOT, ["commit", "-m", "base"]);
}

describe("deleteFile", () => {
  it("removes a file inside the repo", async () => {
    const rel = "sub/a.txt";
    await fs.writeFile(path.join(ROOT, rel), "x");
    await deleteFile(ROOT, rel);
    await expect(fs.access(path.join(ROOT, rel))).rejects.toThrow();
  });

  it("rejects paths that escape the repo root", async () => {
    // A sentinel file just outside the repo must survive the attempt.
    const outside = path.join(ROOT, "..", `sentinel-${randomBytes(4).toString("hex")}.txt`);
    await fs.writeFile(outside, "keep");
    try {
      await expect(deleteFile(ROOT, "../" + path.basename(outside))).rejects.toMatchObject({
        status: 400,
      });
      expect(await fs.readFile(outside, "utf8")).toBe("keep");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

describe("staging", () => {
  it.each([
    [undefined, undefined, true],
    ["false", "true", false],
    ["true", "false", true],
    [undefined, "false", false],
    ["", "true", false],
  ])("respects status.renames=%s over diff.renames=%s while unstaging", async (statusRenames, diffRenames, renamed) => {
    await initRepo();
    if (diffRenames !== undefined) await runGit(ROOT, ["config", "diff.renames", diffRenames]);
    if (statusRenames !== undefined) await runGit(ROOT, ["config", "status.renames", statusRenames]);
    await runGit(ROOT, ["mv", "tracked.txt", "renamed [x].txt"]);
    expect((await getStatus(ROOT)).staged.some((file) => file.status === "R")).toBe(renamed);

    await unstagePaths(ROOT, ["renamed [x].txt"]);

    const staged = (await getStatus(ROOT)).staged;
    expect(staged).toEqual(renamed ? [] : [{ path: "tracked.txt", status: "D", staged: true }]);
    expect(await fs.readFile(path.join(ROOT, "renamed [x].txt"), "utf8")).toBe("base\n");
  });

  it("keeps a copy's modified source staged", async () => {
    await initRepo();
    await runGit(ROOT, ["config", "status.renames", "copies"]);
    await fs.writeFile(path.join(ROOT, "copy.txt"), "base\n");
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "source changed\n");
    await stageAll(ROOT);
    expect((await getStatus(ROOT)).staged).toContainEqual({ path: "copy.txt", oldPath: "tracked.txt", status: "C", staged: true });

    await unstagePaths(ROOT, ["copy.txt"]);

    expect((await getStatus(ROOT)).staged).toEqual([{ path: "tracked.txt", status: "M", staged: true }]);
    expect(await fs.readFile(path.join(ROOT, "copy.txt"), "utf8")).toBe("base\n");
  });

  it("matches status's first diff setting when the config contains multiple rename values", async () => {
    await initRepo();
    await runGit(ROOT, ["config", "--add", "diff.renames", "false"]);
    await runGit(ROOT, ["config", "--add", "diff.renames", "true"]);
    await runGit(ROOT, ["mv", "tracked.txt", "renamed.txt"]);
    expect((await getStatus(ROOT)).staged.some((file) => file.status === "R")).toBe(false);

    await unstagePaths(ROOT, ["renamed.txt"]);

    expect((await getStatus(ROOT)).staged).toEqual([{ path: "tracked.txt", status: "D", staged: true }]);
  });

  it("accepts an implicit true status rename setting", async () => {
    await initRepo();
    await runGit(ROOT, ["config", "diff.renames", "false"]);
    await fs.appendFile(path.join(ROOT, ".git", "config"), "\n[status]\n\trenames\n");
    await runGit(ROOT, ["mv", "tracked.txt", "renamed.txt"]);
    expect((await getStatus(ROOT)).staged[0].status).toBe("R");

    await unstagePaths(ROOT, ["renamed.txt"]);

    expect((await getStatus(ROOT)).staged).toEqual([]);
  });

  it("preserves status behavior when an ignored duplicate diff setting is invalid", async () => {
    await initRepo();
    await runGit(ROOT, ["config", "--add", "diff.renames", "false"]);
    await runGit(ROOT, ["config", "--add", "diff.renames", "invalid"]);
    await runGit(ROOT, ["mv", "tracked.txt", "renamed.txt"]);
    expect((await getStatus(ROOT)).staged.some((file) => file.status === "R")).toBe(false);

    await unstagePaths(ROOT, ["renamed.txt"]);

    expect((await getStatus(ROOT)).staged).toEqual([{ path: "tracked.txt", status: "D", staged: true }]);
  });

  it("does not unstage files when status rejects an earlier rename setting", async () => {
    await initRepo();
    await runGit(ROOT, ["mv", "tracked.txt", "renamed.txt"]);
    await runGit(ROOT, ["config", "--add", "status.renames", "invalid"]);
    await runGit(ROOT, ["config", "--add", "status.renames", "true"]);
    const index = path.join(ROOT, ".git", "index");
    const before = await fs.readFile(index);
    await expect(getStatus(ROOT)).rejects.toThrow();

    await expect(unstagePaths(ROOT, ["renamed.txt"])).rejects.toThrow();

    expect(await fs.readFile(index)).toEqual(before);
  });

  it("does not pair an intent-to-add entry with a staged deletion", async () => {
    await initRepo();
    await fs.writeFile(path.join(ROOT, "empty.txt"), "");
    await stagePaths(ROOT, ["empty.txt"]);
    await commit(ROOT, { title: "empty file" });
    await runGit(ROOT, ["rm", "empty.txt"]);
    await fs.writeFile(path.join(ROOT, "new.txt"), "");
    await runGit(ROOT, ["add", "-N", "new.txt"]);

    await unstagePaths(ROOT, ["new.txt"]);

    expect((await getStatus(ROOT)).staged).toEqual([{ path: "empty.txt", status: "D", staged: true }]);
    expect(await fs.readFile(path.join(ROOT, "new.txt"), "utf8")).toBe("");
  });

  it("unstages an unborn repository without deleting its file", async () => {
    await runGit(ROOT, ["init", "-b", "main"]);
    await fs.writeFile(path.join(ROOT, "new.txt"), "new file\n");
    await stagePaths(ROOT, ["new.txt"]);

    await unstagePaths(ROOT, ["new.txt"]);

    expect(await getStatus(ROOT)).toEqual({ staged: [], unstaged: [{ path: "new.txt", status: "?", staged: false }] });
    expect(await fs.readFile(path.join(ROOT, "new.txt"), "utf8")).toBe("new file\n");
  });

  it.each([1, 20])("matches status's inexact rename pairing at status.renameLimit=%s", async (limit) => {
    await initRepo();
    await runGit(ROOT, ["config", "diff.renameLimit", "1"]);
    await runGit(ROOT, ["config", "status.renameLimit", String(limit)]);
    for (let i = 0; i < 3; i += 1) {
      const content = Array.from({ length: 100 }, (_, line) => `file ${i} original line ${line}\n`).join("");
      await fs.writeFile(path.join(ROOT, `old-${i}.txt`), content);
    }
    await stageAll(ROOT);
    await commit(ROOT, { title: "rename fixtures" });
    for (let i = 0; i < 3; i += 1) {
      await runGit(ROOT, ["mv", `old-${i}.txt`, `new-${i}.txt`]);
      await fs.appendFile(path.join(ROOT, `new-${i}.txt`), "additional line\n");
    }
    await stageAll(ROOT);
    const before = (await getStatus(ROOT)).staged;
    const entry = before.find((file) => file.path === "new-0.txt")!;
    expect(entry.status).toBe(limit === 1 ? "A" : "R");

    await unstagePaths(ROOT, [entry.path]);

    const after = (await getStatus(ROOT)).staged;
    expect(after.some((file) => file.path === entry.path)).toBe(false);
    if (entry.oldPath) expect(after.some((file) => file.path === entry.oldPath)).toBe(false);
    else expect(after).toContainEqual({ path: "old-0.txt", status: "D", staged: true });
  });

  it.each(["-0x1", "-0X01"])("matches status's rename limit fallback after %s", async (limit) => {
    await initRepo();
    await runGit(ROOT, ["config", "status.renameLimit", limit]);
    await runGit(ROOT, ["config", "diff.renameLimit", "1"]);
    for (let i = 0; i < 3; i += 1) {
      const content = Array.from({ length: 100 }, (_, line) => `file ${i} original line ${line}\n`).join("");
      await fs.writeFile(path.join(ROOT, `old-${i}.txt`), content);
    }
    await stageAll(ROOT);
    await commit(ROOT, { title: "rename fixtures" });
    for (let i = 0; i < 3; i += 1) {
      await runGit(ROOT, ["mv", `old-${i}.txt`, `new-${i}.txt`]);
      await fs.appendFile(path.join(ROOT, `new-${i}.txt`), "additional line\n");
    }
    await stageAll(ROOT);
    expect((await getStatus(ROOT)).staged).toContainEqual({ path: "new-0.txt", status: "A", staged: true });

    await unstagePaths(ROOT, ["new-0.txt"]);

    const after = (await getStatus(ROOT)).staged;
    expect(after.some((file) => file.path === "new-0.txt")).toBe(false);
    expect(after).toContainEqual({ path: "old-0.txt", status: "D", staged: true });
    expect(await fs.readFile(path.join(ROOT, "new-0.txt"), "utf8")).toContain("additional line\n");
  });

  it("does not run a working-tree clean filter while looking up staged renames", async () => {
    await initRepo();
    await runGit(ROOT, ["mv", "tracked.txt", "renamed.txt"]);
    await fs.writeFile(path.join(ROOT, ".gitattributes"), "*.txt filter=probe\n");
    await runGit(ROOT, ["config", "filter.probe.clean", "echo scanned > .git/scanned; cat"]);
    await fs.writeFile(path.join(ROOT, "renamed.txt"), "unstaged version\n");

    await unstagePaths(ROOT, ["renamed.txt"]);

    await expect(fs.access(path.join(ROOT, ".git", "scanned"))).rejects.toThrow();
    expect((await runGit(ROOT, ["diff", "--cached", "--name-only"])).stdout).toBe("");
    expect(await fs.readFile(path.join(ROOT, "renamed.txt"), "utf8")).toBe("unstaged version\n");
  });

  it("stages only the requested path and leaves other worktree changes unstaged", async () => {
    await initRepo();
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(ROOT, "other.txt"), "new\n", "utf8");

    await stagePaths(ROOT, ["tracked.txt"]);

    const status = await getStatus(ROOT);
    expect(status.staged.map((f) => f.path)).toEqual(["tracked.txt"]);
    expect(status.unstaged.map((f) => f.path)).toEqual(["other.txt"]);
  });

  it("stages modified, deleted, and untracked files together", async () => {
    await initRepo();
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(ROOT, "deleted.txt"), "delete me\n", "utf8");
    await runGit(ROOT, ["add", "--", "deleted.txt"]);
    await runGit(ROOT, ["commit", "-m", "add second file"]);
    await fs.rm(path.join(ROOT, "deleted.txt"));
    await fs.writeFile(path.join(ROOT, "new.txt"), "new\n", "utf8");

    await stageAll(ROOT);

    const status = await getStatus(ROOT);
    expect(status.unstaged).toEqual([]);
    expect(status.staged.map((f) => [f.path, f.status])).toEqual([
      ["deleted.txt", "D"],
      ["new.txt", "A"],
      ["tracked.txt", "M"],
    ]);
  });

  it("unstages a path without discarding its working-tree contents", async () => {
    await initRepo();
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "changed\n", "utf8");
    await stagePaths(ROOT, ["tracked.txt"]);

    await unstagePaths(ROOT, ["tracked.txt"]);

    const status = await getStatus(ROOT);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([
      { path: "tracked.txt", status: "M", staged: false },
    ]);
    expect(await fs.readFile(path.join(ROOT, "tracked.txt"), "utf8")).toBe("changed\n");
  });

  it("unstages both sides of a staged rename when given its displayed new path", async () => {
    await initRepo();
    await runGit(ROOT, ["mv", "tracked.txt", "renamed.txt"]);
    expect((await getStatus(ROOT)).staged).toEqual([
      {
        path: "renamed.txt",
        oldPath: "tracked.txt",
        status: "R",
        staged: true,
      },
    ]);

    await unstagePaths(ROOT, ["renamed.txt"]);

    const status = await getStatus(ROOT);
    expect(status.staged).toEqual([]);
    expect(status.unstaged.map((file) => [file.path, file.status])).toEqual([
      ["tracked.txt", "D"],
      ["renamed.txt", "?"],
    ]);
    expect(await fs.readFile(path.join(ROOT, "renamed.txt"), "utf8")).toBe("base\n");
  });
});

describe("discard paths", () => {
  it("restores tracked files even when the same selection contains an untracked file", async () => {
    await initRepo();
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(ROOT, "new.txt"), "new\n", "utf8");

    await discardPaths(ROOT, ["tracked.txt", "new.txt"]);

    expect(await getStatus(ROOT)).toEqual({ staged: [], unstaged: [] });
    expect((await fs.readFile(path.join(ROOT, "tracked.txt"), "utf8")).replace(/\r/g, "")).toBe(
      "base\n",
    );
    await expect(fs.access(path.join(ROOT, "new.txt"))).rejects.toThrow();
  });

  it("restores both sides of a staged rename selected by its displayed new path", async () => {
    await initRepo();
    await runGit(ROOT, ["mv", "tracked.txt", "renamed.txt"]);

    await discardPaths(ROOT, ["renamed.txt"]);

    expect(await getStatus(ROOT)).toEqual({ staged: [], unstaged: [] });
    expect((await fs.readFile(path.join(ROOT, "tracked.txt"), "utf8")).replace(/\r/g, "")).toBe(
      "base\n",
    );
    await expect(fs.access(path.join(ROOT, "renamed.txt"))).rejects.toThrow();
  });

  it("treats filename metacharacters as literal when staging, unstaging, and discarding", async () => {
    await initRepo();
    for (const name of ["[ab].txt", "a.txt", "b.txt"]) {
      await fs.writeFile(path.join(ROOT, name), "base\n", "utf8");
    }
    await runGit(ROOT, ["add", "-A"]);
    await runGit(ROOT, ["commit", "-m", "add pathspec fixtures"]);
    for (const name of ["[ab].txt", "a.txt", "b.txt"]) {
      await fs.writeFile(path.join(ROOT, name), "changed\n", "utf8");
    }

    await stagePaths(ROOT, ["[ab].txt"]);
    expect((await getStatus(ROOT)).staged.map((file) => file.path)).toEqual(["[ab].txt"]);

    await unstagePaths(ROOT, ["[ab].txt"]);
    expect((await getStatus(ROOT)).staged).toEqual([]);

    await discardPaths(ROOT, ["[ab].txt"]);
    expect((await fs.readFile(path.join(ROOT, "[ab].txt"), "utf8")).replace(/\r/g, "")).toBe(
      "base\n",
    );
    expect((await fs.readFile(path.join(ROOT, "a.txt"), "utf8")).replace(/\r/g, "")).toBe(
      "changed\n",
    );
    expect((await fs.readFile(path.join(ROOT, "b.txt"), "utf8")).replace(/\r/g, "")).toBe(
      "changed\n",
    );
  });
});

describe("background status", () => {
  it("reports staged and unstaged changes without rewriting the index", async () => {
    await initRepo();
    await fs.writeFile(path.join(ROOT, "staged.txt"), "staged\n", "utf8");
    await stagePaths(ROOT, ["staged.txt"]);
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "changed\n", "utf8");
    const index = path.join(ROOT, ".git", "index");
    const before = await fs.readFile(index);
    const stat = await fs.stat(index);

    const status = await getStatus(ROOT, true);

    expect(status.staged.map((file) => file.path)).toEqual(["staged.txt"]);
    expect(status.unstaged.map((file) => file.path)).toEqual(["tracked.txt"]);
    expect(await fs.readFile(index)).toEqual(before);
    expect((await fs.stat(index)).mtimeMs).toBe(stat.mtimeMs);
  });
});

describe("commit", () => {
  it("runs commit hooks and preserves the index when a hook rejects the commit", async () => {
    await initRepo();
    const before = (await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "changed\n", "utf8");
    await stagePaths(ROOT, ["tracked.txt"]);
    const hook = path.join(ROOT, ".git", "hooks", "pre-commit");
    await fs.writeFile(hook, "#!/bin/sh\necho hook-rejected >&2\nexit 1\n", { mode: 0o755 });

    await expect(commit(ROOT, { title: "rejected" })).rejects.toThrow("hook-rejected");
    expect((await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
    expect((await getStatus(ROOT)).staged.map((file) => file.path)).toEqual(["tracked.txt"]);
  });

  it("preserves the summary and multi-line description as separate message sections", async () => {
    await initRepo();
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "changed\n", "utf8");
    await stagePaths(ROOT, ["tracked.txt"]);

    const hash = await commit(ROOT, {
      title: "  Core summary  ",
      description: "  First detail\nSecond detail  ",
    });

    expect(hash).toBe((await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim());
    const message = (await runGit(ROOT, ["show", "-s", "--format=%B", "HEAD"])).stdout;
    expect(message.replace(/\r/g, "")).toBe("Core summary\n\nFirst detail\nSecond detail\n\n");
    expect(await getStatus(ROOT)).toEqual({ staged: [], unstaged: [] });
  });

  it("commits only the index and leaves unstaged changes pending", async () => {
    await initRepo();
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "staged version\n", "utf8");
    await stagePaths(ROOT, ["tracked.txt"]);
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "unstaged version\n", "utf8");

    await commit(ROOT, { title: "index only" });

    expect(
      (await runGit(ROOT, ["show", "HEAD:tracked.txt"])).stdout.replace(/\r/g, ""),
    ).toBe("staged version\n");
    expect(await fs.readFile(path.join(ROOT, "tracked.txt"), "utf8")).toBe("unstaged version\n");
    expect((await getStatus(ROOT)).unstaged).toEqual([
      { path: "tracked.txt", status: "M", staged: false },
    ]);
  });

  it("uses the supplied identity without modifying repository config", async () => {
    await initRepo();
    await fs.writeFile(path.join(ROOT, "tracked.txt"), "changed\n", "utf8");
    await stagePaths(ROOT, ["tracked.txt"]);

    await commit(ROOT, {
      title: "custom identity",
      identity: { name: "UI User", email: "ui@example.com" },
    });

    const author = (await runGit(ROOT, ["show", "-s", "--format=%an <%ae>", "HEAD"])).stdout.trim();
    expect(author).toBe("UI User <ui@example.com>");
    expect((await runGit(ROOT, ["config", "user.name"])).stdout.trim()).toBe("Configured User");
    expect((await runGit(ROOT, ["config", "user.email"])).stdout.trim()).toBe(
      "configured@example.com",
    );
  });

  it("amends HEAD with the replacement summary and description", async () => {
    await initRepo();
    const before = (await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim();

    const hash = await commit(ROOT, {
      title: "replacement summary",
      description: "replacement detail",
      amend: true,
    });

    expect(hash).not.toBe(before);
    expect((await runGit(ROOT, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect(
      (await runGit(ROOT, ["show", "-s", "--format=%B", "HEAD"])).stdout.replace(/\r/g, ""),
    ).toBe("replacement summary\n\nreplacement detail\n\n");
  });

  it("rejects an empty summary without creating a commit", async () => {
    await initRepo();
    const before = (await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim();

    await expect(commit(ROOT, { title: " \t\n " })).rejects.toMatchObject({ status: 400 });
    expect((await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
  });
});
