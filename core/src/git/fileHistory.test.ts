import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getFileHistory, parseFileHistoryLog } from "./fileHistory.js";
import { runGit } from "./gitRunner.js";

const BASE = path.join(os.tmpdir(), `gitwebui-file-history-${randomBytes(6).toString("hex")}`);
const ROOT = path.join(BASE, "repo");

beforeEach(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "user.name", "History Author"]);
  await runGit(ROOT, ["config", "user.email", "history@example.com"]);
});

afterAll(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
});

async function commitAll(message: string): Promise<string> {
  await runGit(ROOT, ["add", "-A"]);
  await runGit(ROOT, ["commit", "-m", message]);
  return (await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("file-history parser", () => {
  it("combines commit metadata with NUL-delimited rename status", () => {
    const hash = "1234567890abcdef1234567890abcdef12345678";
    const parent = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const output = [
      "",
      hash,
      "1234567",
      parent,
      "Ada",
      "ada@example.com",
      "2026-01-02T03:04:05Z",
      "Rename file",
      "\nR100",
      "old [x].txt",
      "new [x].txt",
      "",
    ].join("\0");

    expect(parseFileHistoryLog(output)).toEqual([{
      hash,
      shortHash: "1234567",
      parents: [parent],
      author: "Ada",
      email: "ada@example.com",
      dateISO: "2026-01-02T03:04:05Z",
      subject: "Rename file",
      status: "R",
      path: "new [x].txt",
      oldPath: "old [x].txt",
      contentHash: hash,
      contentPath: "new [x].txt",
    }]);
  });

  it("preserves legal control bytes in commit subjects and filenames", () => {
    const hash = "1234567890abcdef1234567890abcdef12345678";
    const subject = "Keep \x1e and \x1f intact";
    const target = "control-\x1e-name.txt";
    const output = [
      "",
      hash,
      "1234567",
      "",
      "Ada",
      "ada@example.com",
      "2026-01-02T03:04:05Z",
      subject,
      "\nA",
      target,
      "",
    ].join("\0");

    expect(parseFileHistoryLog(output)).toEqual([{
      hash,
      shortHash: "1234567",
      parents: [],
      author: "Ada",
      email: "ada@example.com",
      dateISO: "2026-01-02T03:04:05Z",
      subject,
      status: "A",
      path: target,
      oldPath: null,
      contentHash: hash,
      contentPath: target,
    }]);
  });
});

describe("file history", () => {
  it("follows a literal unusual filename across a rename", async () => {
    const originalPath = "odd [draft].txt";
    const renamedPath = "final [draft].txt";
    await fs.writeFile(path.join(ROOT, originalPath), "keep\nremember me\n");
    const added = await commitAll("Add remembered text");
    await fs.writeFile(path.join(ROOT, originalPath), "keep\nreplacement\n");
    const removed = await commitAll("Remove remembered text");
    await runGit(ROOT, ["mv", originalPath, renamedPath]);
    const renamed = await commitAll("Rename the file");

    const history = await getFileHistory(ROOT, renamedPath, 0, 2);

    expect(history.entries.map((entry) => entry.hash)).toEqual([renamed, removed]);
    expect(history.entries[0]).toMatchObject({
      status: "R",
      path: renamedPath,
      oldPath: originalPath,
    });
    expect(history.hasMore).toBe(true);
    await expect(getFileHistory(ROOT, renamedPath, 2, 2)).resolves.toMatchObject({
      entries: [{ hash: added }],
      hasMore: false,
    });
  });

  it("uses exact pickaxe text to find both its addition and disappearance", async () => {
    const target = "memory.txt";
    await fs.writeFile(path.join(ROOT, target), "ordinary\n");
    await commitAll("Base");
    await fs.writeFile(path.join(ROOT, target), "ordinary\nvanishing phrase\n");
    const added = await commitAll("Add phrase");
    await fs.writeFile(path.join(ROOT, target), "ordinary\n");
    const removed = await commitAll("Remove phrase");

    const result = await getFileHistory(ROOT, target, 0, 20, "vanishing phrase");

    expect(result.entries.map((entry) => entry.hash)).toEqual([removed, added]);
    expect(result.query).toBe("vanishing phrase");
  });

  it("points a deletion at its last existing parent image and paginates", async () => {
    const target = "deleted.txt";
    await fs.writeFile(path.join(ROOT, target), "first\n");
    const added = await commitAll("Add file");
    await fs.writeFile(path.join(ROOT, target), "second\n");
    const modified = await commitAll("Modify file");
    await fs.rm(path.join(ROOT, target));
    const deleted = await commitAll("Delete file");

    const firstPage = await getFileHistory(ROOT, target, 0, 2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.entries.map((entry) => entry.hash)).toEqual([deleted, modified]);
    expect(firstPage.entries[0]).toMatchObject({
      status: "D",
      contentHash: modified,
      contentPath: target,
    });
    await expect(getFileHistory(ROOT, target, 2, 2)).resolves.toMatchObject({
      entries: [{ hash: added }],
      hasMore: false,
    });
  });

  it("includes a merge commit when its conflict resolution changes the file", async () => {
    const target = "resolved.txt";
    await fs.writeFile(path.join(ROOT, target), "base\ncommon\n");
    const base = await commitAll("Base file");
    await runGit(ROOT, ["switch", "-c", "side"]);
    await fs.writeFile(path.join(ROOT, target), "side\ncommon\n");
    const side = await commitAll("Side change");
    await runGit(ROOT, ["switch", "main"]);
    await fs.writeFile(path.join(ROOT, target), "main\ncommon\n");
    const main = await commitAll("Main change");
    await expect(runGit(ROOT, ["merge", "side", "--no-ff", "-m", "Merge side"])).rejects.toThrow();
    await fs.writeFile(path.join(ROOT, target), "resolved differently\ncommon\n");
    const merge = await commitAll("Resolve merge");

    const history = await getFileHistory(ROOT, target, 0, 20);

    expect(history.entries[0]).toMatchObject({ hash: merge, status: "M" });
    expect(history.entries.map((entry) => entry.hash)).toEqual(expect.arrayContaining([main, side, base]));
  });

  it("finds a historical-only file reachable from another branch", async () => {
    await runGit(ROOT, ["commit", "--allow-empty", "-m", "Main root"]);
    await runGit(ROOT, ["switch", "-c", "other"]);
    await fs.writeFile(path.join(ROOT, "branch-only.txt"), "only on this branch\n");
    const branchCommit = await commitAll("Add branch-only file");
    await runGit(ROOT, ["switch", "main"]);

    await expect(getFileHistory(ROOT, "branch-only.txt", 0, 20)).resolves.toMatchObject({
      entries: [{ hash: branchCommit, status: "A" }],
      hasMore: false,
    });
  });
});
