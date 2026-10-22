import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { runGit } from "./gitRunner.js";
import {
  parseWorktrees,
  listWorktrees,
  addWorktree,
  removeWorktree,
  samePath,
} from "./worktree.js";

const ROOT = path.join(os.tmpdir(), `gitwebui-worktree-${randomBytes(6).toString("hex")}`);

async function setup(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "user.email", "t@example.com"]);
  await runGit(ROOT, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(ROOT, "a.txt"), "one\n", "utf8");
  await runGit(ROOT, ["add", "-A"]);
  await runGit(ROOT, ["commit", "-m", "base"]);
}

beforeEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});
afterAll(() => fs.rm(ROOT, { recursive: true, force: true }));

describe("parseWorktrees", () => {
  it("parses porcelain records and marks the main worktree", () => {
    const out = parseWorktrees(
      "worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n\n" +
        "worktree /repo/linked\nHEAD def456\nbranch refs/heads/feature\n\n" +
        "worktree /repo/detached\nHEAD 999\ndetached\n",
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ path: "/repo/main", branch: "main", isMain: true });
    expect(out[1]).toMatchObject({ path: "/repo/linked", branch: "feature", isMain: false });
    expect(out[2]).toMatchObject({ path: "/repo/detached", branch: null, detached: true });
  });
});

describe("worktree operations", () => {
  it("lists the main worktree and marks it current", async () => {
    await setup();
    const wts = await listWorktrees(ROOT);
    expect(wts).toHaveLength(1);
    expect(wts[0].isMain).toBe(true);
    expect(wts[0].current).toBe(true);
    expect(wts[0].branch).toBe("main");
  });

  it("adds a worktree with a new branch and removes it", async () => {
    await setup();
    const wtPath = path.join(ROOT + "-wt", "feature");
    await addWorktree(ROOT, { path: wtPath, ref: "main", newBranch: "feature" });

    let wts = await listWorktrees(ROOT);
    expect(wts).toHaveLength(2);
    const added = wts.find((w) => w.branch === "feature");
    expect(added).toBeTruthy();
    expect(samePath(added!.path, wtPath)).toBe(true);
    // The new branch checked out a copy of a.txt.
    expect(await fs.readFile(path.join(wtPath, "a.txt"), "utf8")).toContain("one");

    await removeWorktree(ROOT, wtPath);
    wts = await listWorktrees(ROOT);
    expect(wts).toHaveLength(1);
    // The branch that lived in the worktree is deleted along with it.
    const branchList = (await runGit(ROOT, ["branch", "--list", "feature"])).stdout.trim();
    expect(branchList).toBe("");

    await fs.rm(ROOT + "-wt", { recursive: true, force: true });
  });

  it("rejects worktree parameters that look like flags", async () => {
    await setup();
    await expect(addWorktree(ROOT, { path: "-x", ref: "main" })).rejects.toMatchObject({
      status: 400,
    });
  });
});
