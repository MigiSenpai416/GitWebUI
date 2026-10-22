import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMainHistory } from "./log.js";
import { runGit } from "./gitRunner.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gitwebui-main-history-"));
  await runGit(root, ["init", "-b", "main"]);
  await runGit(root, ["config", "user.name", "Graph Test"]);
  await runGit(root, ["config", "user.email", "graph@example.com"]);
  await runGit(root, ["config", "commit.gpgsign", "false"]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("main graph history", () => {
  it("reads only main's first parents even while another branch is checked out", async () => {
    await runGit(root, ["commit", "--allow-empty", "-m", "Root"]);
    const base = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    await runGit(root, ["checkout", "-b", "feature"]);
    await runGit(root, ["commit", "--allow-empty", "-m", "Feature"]);
    await runGit(root, ["checkout", "main"]);
    await runGit(root, ["merge", "--no-ff", "feature", "-m", "Merge feature"]);
    const merge = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    await runGit(root, ["checkout", "feature"]);
    expect(await getMainHistory(root)).toEqual([merge, base]);
    const controller = new AbortController();
    controller.abort();
    await expect(getMainHistory(root, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns no pin for an unborn repository or a repository without local main", async () => {
    expect(await getMainHistory(root)).toEqual([]);
    await runGit(root, ["commit", "--allow-empty", "-m", "Root"]);
    await runGit(root, ["branch", "-m", "trunk"]);
    expect(await getMainHistory(root)).toEqual([]);
  });
});
