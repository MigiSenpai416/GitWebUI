import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { runGit } from "./gitRunner.js";
import {
  checkoutBranch,
  checkoutRemoteBranch,
  createBranchAt,
  deleteBranch,
  getBranches,
} from "./branches.js";
import { currentBranch } from "./repo.js";

const BASE = path.join(os.tmpdir(), `gitwebui-branches-${randomBytes(6).toString("hex")}`);
const ORIGIN = path.join(BASE, "origin");
const WORK = path.join(BASE, "work");

async function write(root: string, rel: string, content: string): Promise<void> {
  await fs.writeFile(path.join(root, rel), content, "utf8");
}

/**
 * Build an `origin` repo with `main` and `feature`, then a `work` repo that has
 * `origin` as a remote and has fetched it — so `refs/remotes/origin/*` exist but
 * no local `feature` yet.
 */
async function setupRemote(): Promise<void> {
  await fs.mkdir(ORIGIN, { recursive: true });
  await runGit(ORIGIN, ["init", "-b", "main"]);
  await runGit(ORIGIN, ["config", "user.email", "t@example.com"]);
  await runGit(ORIGIN, ["config", "user.name", "Test"]);
  await write(ORIGIN, "a.txt", "one\n");
  await runGit(ORIGIN, ["add", "-A"]);
  await runGit(ORIGIN, ["commit", "-m", "base"]);
  await runGit(ORIGIN, ["checkout", "-b", "feature"]);
  await write(ORIGIN, "b.txt", "feature\n");
  await runGit(ORIGIN, ["add", "-A"]);
  await runGit(ORIGIN, ["commit", "-m", "feature work"]);
  await runGit(ORIGIN, ["checkout", "main"]);

  await fs.mkdir(WORK, { recursive: true });
  await runGit(WORK, ["init", "-b", "main"]);
  await runGit(WORK, ["config", "user.email", "t@example.com"]);
  await runGit(WORK, ["config", "user.name", "Test"]);
  await runGit(WORK, ["remote", "add", "origin", ORIGIN]);
  await runGit(WORK, ["fetch", "origin"]);
  // Establish a local main so the work tree has a HEAD to switch away from.
  await runGit(WORK, ["reset", "--hard", "origin/main"]);
}

beforeEach(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
});
afterAll(() => fs.rm(BASE, { recursive: true, force: true }));

describe("checkoutRemoteBranch", () => {
  it("creates a local tracking branch from a remote and switches to it", async () => {
    await setupRemote();
    await checkoutRemoteBranch(WORK, "origin/feature", "feature");

    expect(await currentBranch(WORK)).toBe("feature");
    // The feature file is now present in the working tree.
    expect(await fs.readFile(path.join(WORK, "b.txt"), "utf8")).toContain("feature");
    // The new local branch tracks the remote.
    const feature = (await getBranches(WORK)).find((b) => b.name === "feature");
    expect(feature?.upstream).toBe("origin/feature");
  });

  it("just switches when the local branch already exists", async () => {
    await setupRemote();
    // Create the local branch up front, then ask to check out the remote one.
    await runGit(WORK, ["branch", "feature", "origin/feature"]);
    await checkoutRemoteBranch(WORK, "origin/feature", "feature");

    expect(await currentBranch(WORK)).toBe("feature");
    // Only one local `feature` — it wasn't duplicated or errored on re-create.
    const features = (await getBranches(WORK)).filter((b) => b.name === "feature");
    expect(features).toHaveLength(1);
  });

  it("preserves the real upstream when a same-named local branch already exists", async () => {
    await setupRemote();
    await runGit(WORK, ["branch", "--no-track", "feature", "main"]);

    await checkoutRemoteBranch(WORK, "origin/feature", "feature");

    expect(await currentBranch(WORK)).toBe("feature");
    const feature = (await getBranches(WORK)).find((b) => b.name === "feature");
    expect(feature?.upstream).toBeNull();
  });

  it("rejects branch names that look like flags", async () => {
    await setupRemote();
    await expect(checkoutRemoteBranch(WORK, "-x", "feature")).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("local branch lifecycle", () => {
  it("rejects checkout options without changing the current branch", async () => {
    await setupRemote();

    await expect(checkoutBranch(WORK, "--detach")).rejects.toMatchObject({ status: 400 });
    expect(await currentBranch(WORK)).toBe("main");
  });

  it("creates a branch at the requested commit, checks it out, and deletes it after switching away", async () => {
    await setupRemote();
    const base = (await runGit(WORK, ["rev-parse", "HEAD"])).stdout.trim();
    await write(WORK, "later.txt", "main-only\n");
    await runGit(WORK, ["add", "--", "later.txt"]);
    await runGit(WORK, ["commit", "-m", "later main work"]);
    const mainTip = (await runGit(WORK, ["rev-parse", "HEAD"])).stdout.trim();

    await createBranchAt(WORK, "topic/core-work", base);

    expect(await currentBranch(WORK)).toBe("topic/core-work");
    expect((await runGit(WORK, ["rev-parse", "HEAD"])).stdout.trim()).toBe(base);
    expect((await getBranches(WORK)).find((b) => b.name === "topic/core-work")?.current).toBe(
      true,
    );

    await checkoutBranch(WORK, "main");
    expect((await runGit(WORK, ["rev-parse", "HEAD"])).stdout.trim()).toBe(mainTip);
    await deleteBranch(WORK, "topic/core-work");

    expect((await getBranches(WORK)).map((b) => b.name)).not.toContain("topic/core-work");
    expect(await currentBranch(WORK)).toBe("main");
  });
});
