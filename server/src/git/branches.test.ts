import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { runGit } from "./gitRunner.js";
import { checkoutRemoteBranch, getBranches } from "./branches.js";
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

  it("rejects branch names that look like flags", async () => {
    await setupRemote();
    await expect(checkoutRemoteBranch(WORK, "-x", "feature")).rejects.toMatchObject({
      status: 400,
    });
  });
});
