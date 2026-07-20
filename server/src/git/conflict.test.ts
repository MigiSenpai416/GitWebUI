import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { runGit } from "./gitRunner.js";
import {
  getMergeState,
  getConflictFile,
  writeResolution,
  isConflicted,
  mergeBranch,
  cherryPick,
  abortMerge,
} from "./conflict.js";
import { checkoutCommit } from "./branches.js";
import { currentBranch } from "./repo.js";

async function revParse(ref: string): Promise<string> {
  return (await runGit(ROOT, ["rev-parse", ref])).stdout.trim();
}

const ROOT = path.join(os.tmpdir(), `gitwebui-conflict-${randomBytes(6).toString("hex")}`);

async function write(rel: string, content: string): Promise<void> {
  await fs.writeFile(path.join(ROOT, rel), content, "utf8");
}

/** Build a repo with `main` and `feature` that both edit line 2 of a.txt. */
async function setupConflict(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "user.email", "t@example.com"]);
  await runGit(ROOT, ["config", "user.name", "Test"]);
  await write("a.txt", "one\ntwo\nthree\n");
  await runGit(ROOT, ["add", "-A"]);
  await runGit(ROOT, ["commit", "-m", "base"]);

  await runGit(ROOT, ["checkout", "-b", "feature"]);
  await write("a.txt", "one\nTHEIRS\nthree\n");
  await runGit(ROOT, ["commit", "-am", "feature edit"]);

  await runGit(ROOT, ["checkout", "main"]);
  await write("a.txt", "one\nOURS\nthree\n");
  await runGit(ROOT, ["commit", "-am", "main edit"]);
}

beforeEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});
afterAll(() => fs.rm(ROOT, { recursive: true, force: true }));

describe("merge conflict state", () => {
  it("reports no merge on a clean repo", async () => {
    await setupConflict();
    const state = await getMergeState(ROOT);
    expect(state.active).toBe(false);
    expect(await isConflicted(ROOT)).toBe(false);
  });

  it("surfaces a conflict from a merge and its three-way content", async () => {
    await setupConflict();
    await mergeBranch(ROOT, "feature"); // conflicts, but must not throw

    expect(await isConflicted(ROOT)).toBe(true);
    const state = await getMergeState(ROOT);
    expect(state.active).toBe(true);
    expect(state.kind).toBe("merge");
    expect(state.intoBranch).toBe("main");
    expect(state.conflicted).toContain("a.txt");
    expect(state.message).toMatch(/conflict/i);

    const file = await getConflictFile(ROOT, "a.txt");
    expect(file.merged).toContain("<<<<<<<");
    expect(file.merged).toContain("OURS");
    expect(file.merged).toContain("THEIRS");
    expect(file.oursLabel).toContain("main");
  });

  it("resolving and staging clears the conflict", async () => {
    await setupConflict();
    await mergeBranch(ROOT, "feature");

    await writeResolution(ROOT, "a.txt", "one\nOURS\nthree\n", true);
    expect(await isConflicted(ROOT)).toBe(false);
    // The merge is still in progress (awaiting the commit) but has no conflicts.
    const state = await getMergeState(ROOT);
    expect(state.active).toBe(true);
    expect(state.conflicted).toHaveLength(0);
  });

  it("aborts a conflicted merge back to a clean state", async () => {
    await setupConflict();
    await mergeBranch(ROOT, "feature");
    expect(await isConflicted(ROOT)).toBe(true);

    await abortMerge(ROOT);
    expect(await isConflicted(ROOT)).toBe(false);
    expect((await getMergeState(ROOT)).active).toBe(false);
    // Working tree restored to the main edit.
    expect(await fs.readFile(path.join(ROOT, "a.txt"), "utf8")).toContain("OURS");
  });
});

describe("cherry-pick", () => {
  it("commits a non-conflicting pick", async () => {
    await setupConflict();
    // feature's edit conflicts, so add a clean-picking commit on feature.
    await runGit(ROOT, ["checkout", "feature"]);
    await write("b.txt", "hello\n");
    await runGit(ROOT, ["add", "-A"]);
    await runGit(ROOT, ["commit", "-m", "add b"]);
    const pick = await revParse("feature");
    await runGit(ROOT, ["checkout", "main"]);

    await cherryPick(ROOT, pick, false);
    expect(await isConflicted(ROOT)).toBe(false);
    expect((await fs.readFile(path.join(ROOT, "b.txt"), "utf8")).replace(/\r/g, "")).toBe("hello\n");
    const log = (await runGit(ROOT, ["log", "-1", "--format=%s"])).stdout.trim();
    expect(log).toBe("add b");
  });

  it("with noCommit leaves the change staged without committing", async () => {
    await setupConflict();
    await runGit(ROOT, ["checkout", "feature"]);
    await write("b.txt", "hello\n");
    await runGit(ROOT, ["add", "-A"]);
    await runGit(ROOT, ["commit", "-m", "add b"]);
    const pick = await revParse("feature");
    await runGit(ROOT, ["checkout", "main"]);
    const before = await revParse("HEAD");

    await cherryPick(ROOT, pick, true);
    expect(await isConflicted(ROOT)).toBe(false);
    expect(await revParse("HEAD")).toBe(before); // no new commit
    expect((await fs.readFile(path.join(ROOT, "b.txt"), "utf8")).replace(/\r/g, "")).toBe("hello\n");
  });

  it("surfaces a conflicting pick as merge state", async () => {
    await setupConflict();
    const pick = await revParse("feature");
    await cherryPick(ROOT, pick, false); // conflicts on a.txt, must not throw

    expect(await isConflicted(ROOT)).toBe(true);
    const state = await getMergeState(ROOT);
    expect(state.active).toBe(true);
    expect(state.kind).toBe("cherry-pick");
    expect(state.conflicted).toContain("a.txt");
  });
});

describe("checkout a commit (detached HEAD)", () => {
  it("detaches HEAD at the target commit", async () => {
    await setupConflict();
    const base = (await runGit(ROOT, ["rev-list", "--max-parents=0", "HEAD"])).stdout.trim();
    await checkoutCommit(ROOT, base);
    // Detached HEAD: symbolic branch resolves to "HEAD".
    expect(await currentBranch(ROOT)).toBe("HEAD");
    expect(await revParse("HEAD")).toBe(base);
    // The base commit had a.txt = "one\ntwo\nthree".
    expect(await fs.readFile(path.join(ROOT, "a.txt"), "utf8")).toContain("two");
  });
});
