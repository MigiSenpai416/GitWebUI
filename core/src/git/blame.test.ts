import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getBlame, parseBlamePorcelain } from "./blame.js";
import { runGit } from "./gitRunner.js";

const BASE = path.join(os.tmpdir(), `gitwebui-blame-${randomBytes(6).toString("hex")}`);
const ROOT = path.join(BASE, "repo");

beforeEach(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "user.name", "First Author"]);
  await runGit(ROOT, ["config", "user.email", "first@example.com"]);
});

afterAll(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
});

async function commitAll(message: string): Promise<string> {
  await runGit(ROOT, ["add", "-A"]);
  await runGit(ROOT, ["commit", "-m", message]);
  return (await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("blame porcelain parser", () => {
  it("retains line origins, rename metadata, and quoted UTF-8 paths", () => {
    const hash = "1234567890abcdef1234567890abcdef12345678";
    const output = [
      `${hash} 7 2 1`,
      "author Ada Lovelace",
      "author-mail <ada@example.com>",
      "author-time 1700000000",
      "author-tz +0000",
      "committer Grace Hopper",
      "committer-mail <grace@example.com>",
      "committer-time 1700000100",
      "committer-tz +0000",
      "summary Move useful line",
      `previous aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \"caf\\303\\251 old.txt\"`,
      `filename \"caf\\303\\251.txt\"`,
      "\tconst answer = 42;",
      "",
    ].join("\n");

    expect(parseBlamePorcelain(output, "café.txt")).toEqual({
      path: "café.txt",
      snapshot: "working-tree",
      revision: null,
      commits: [{
        hash,
        shortHash: "12345678",
        author: "Ada Lovelace",
        email: "ada@example.com",
        authorTime: 1700000000,
        committer: "Grace Hopper",
        committerEmail: "grace@example.com",
        committerTime: 1700000100,
        summary: "Move useful line",
        boundary: false,
        uncommitted: false,
      }],
      lines: [{
        lineNumber: 2,
        originalLine: 7,
        commitHash: hash,
        originalPath: "café.txt",
        previousHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        previousPath: "café old.txt",
        text: "const answer = 42;",
      }],
    });
  });
});

describe("working-tree blame", () => {
  it("explains committed authorship and marks local edits as uncommitted", async () => {
    const target = "notes [draft].txt";
    await fs.writeFile(path.join(ROOT, target), "first line\nshared line\n");
    const first = await commitAll("Add the notes");
    await runGit(ROOT, ["config", "user.name", "Second Author"]);
    await runGit(ROOT, ["config", "user.email", "second@example.com"]);
    await fs.writeFile(path.join(ROOT, target), "first line\nshared line\nlast committed\n");
    const second = await commitAll("Finish the notes");
    await fs.writeFile(path.join(ROOT, target), "first line\nlocally changed\nlast committed\n");

    const blame = await getBlame(ROOT, target);
    const byHash = new Map(blame.commits.map((commit) => [commit.hash, commit]));

    expect(blame.path).toBe(target);
    expect(blame.snapshot).toBe("working-tree");
    expect(blame.lines.map((line) => line.text)).toEqual([
      "first line",
      "locally changed",
      "last committed",
    ]);
    expect(blame.lines[0].commitHash).toBe(first);
    expect(blame.lines[2].commitHash).toBe(second);
    expect(byHash.get(first)).toMatchObject({ author: "First Author", summary: "Add the notes" });
    expect(byHash.get(second)).toMatchObject({ author: "Second Author", summary: "Finish the notes" });
    expect(byHash.get(blame.lines[1].commitHash)).toMatchObject({ uncommitted: true });
  });

  it("returns an empty result for an empty tracked file", async () => {
    await fs.writeFile(path.join(ROOT, "empty.txt"), "");
    await commitAll("Add empty file");

    await expect(getBlame(ROOT, "empty.txt")).resolves.toEqual({
      path: "empty.txt",
      snapshot: "working-tree",
      revision: null,
      lines: [],
      commits: [],
    });
  });

  it("falls back to the labelled HEAD snapshot for a locally deleted file", async () => {
    await fs.writeFile(path.join(ROOT, "deleted.txt"), "still explainable\n");
    const head = await commitAll("Add deletable file");
    await fs.rm(path.join(ROOT, "deleted.txt"));

    await expect(getBlame(ROOT, "deleted.txt")).resolves.toMatchObject({
      path: "deleted.txt",
      snapshot: "head",
      revision: null,
      lines: [{ lineNumber: 1, commitHash: head, text: "still explainable" }],
      commits: [{ hash: head, summary: "Add deletable file" }],
    });
  });

  it("blames the exact file image at a historical commit", async () => {
    await fs.writeFile(path.join(ROOT, "historical.txt"), "original\n");
    const original = await commitAll("Original version");
    await fs.writeFile(path.join(ROOT, "historical.txt"), "changed later\n");
    await commitAll("Later version");

    await expect(getBlame(ROOT, "historical.txt", original)).resolves.toMatchObject({
      path: "historical.txt",
      snapshot: "revision",
      revision: original,
      lines: [{ text: "original", commitHash: original }],
    });
  });
});
