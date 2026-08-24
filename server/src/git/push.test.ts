import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { runGit } from "./gitRunner.js";
import { push, pull, deleteRemoteBranch, authArgsForRemote } from "./remote.js";
import { getRemoteBranches } from "./branches.js";

const BASE = path.join(os.tmpdir(), `gitwebui-push-${randomBytes(6).toString("hex")}`);
const ORIGIN = path.join(BASE, "origin.git");
const WORK = path.join(BASE, "work");

async function revParse(root: string, ref: string): Promise<string> {
  return (await runGit(root, ["rev-parse", ref])).stdout.trim();
}

/**
 * A `work` repo whose `main` was pushed to a bare `origin`, then amended — so the
 * local tip is no longer a fast-forward of `origin/main` (a push must be
 * rejected), matching the "amend an already-pushed commit" scenario.
 */
async function setupAmended(): Promise<void> {
  await fs.mkdir(BASE, { recursive: true });
  await runGit(BASE, ["init", "--bare", "origin.git"]);

  await fs.mkdir(WORK, { recursive: true });
  await runGit(WORK, ["init", "-b", "main"]);
  await runGit(WORK, ["config", "user.email", "t@example.com"]);
  await runGit(WORK, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(WORK, "a.txt"), "one\n", "utf8");
  await runGit(WORK, ["add", "-A"]);
  await runGit(WORK, ["commit", "-m", "first"]);
  await runGit(WORK, ["remote", "add", "origin", ORIGIN]);
  await runGit(WORK, ["push", "-u", "origin", "main"]);

  // Amend the pushed commit: same parent, new hash → diverges from origin/main.
  await fs.writeFile(path.join(WORK, "a.txt"), "one\ntwo\n", "utf8");
  await runGit(WORK, ["commit", "-a", "--amend", "--no-edit"]);
}

/**
 * `work` and `origin` diverged because the REMOTE moved: a second clone pushed a
 * commit `work` never fetched, then `work` committed on top of its stale view.
 * A lease can't be verified here — the case bare force exists for. Returns the
 * teammate's commit so a test can assert whether it survived.
 */
async function setupRemoteAdvanced(): Promise<{ theirHead: string }> {
  await fs.mkdir(BASE, { recursive: true });
  await runGit(BASE, ["init", "--bare", "origin.git"]);
  await fs.mkdir(WORK, { recursive: true });
  await runGit(WORK, ["init", "-b", "main"]);
  await runGit(WORK, ["config", "user.email", "t@example.com"]);
  await runGit(WORK, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(WORK, "a.txt"), "one\n", "utf8");
  await runGit(WORK, ["add", "-A"]);
  await runGit(WORK, ["commit", "-m", "first"]);
  await runGit(WORK, ["remote", "add", "origin", ORIGIN]);
  await runGit(WORK, ["push", "-u", "origin", "main"]);

  const other = path.join(BASE, "other");
  await runGit(BASE, ["clone", ORIGIN, "other"]);
  await runGit(other, ["config", "user.email", "o@example.com"]);
  await runGit(other, ["config", "user.name", "Other"]);
  await fs.writeFile(path.join(other, "b.txt"), "theirs\n", "utf8");
  await runGit(other, ["add", "-A"]);
  await runGit(other, ["commit", "-m", "their work"]);
  await runGit(other, ["push", "origin", "main"]);
  const theirHead = await revParse(other, "HEAD");

  // work1 commits locally without fetching origin's new commit.
  await fs.writeFile(path.join(WORK, "a.txt"), "one\nmine\n", "utf8");
  await runGit(WORK, ["commit", "-am", "my work"]);
  return { theirHead };
}

beforeEach(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
});
afterAll(() => fs.rm(BASE, { recursive: true, force: true }));

describe("push", () => {
  it("derives token use from a remote's distinct fetch and push URLs", async () => {
    await fs.mkdir(WORK, { recursive: true });
    await runGit(WORK, ["init", "-b", "main"]);
    await runGit(WORK, ["remote", "add", "origin", "https://github.com/me/repo.git"]);
    await runGit(WORK, [
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://github.com.evil.example/steal.git",
    ]);

    const fetchArgs = await authArgsForRemote(WORK, "secret-token", "origin", false);
    const pushArgs = await authArgsForRemote(WORK, "secret-token", "origin", true);

    expect(
      fetchArgs.some((arg) =>
        arg.startsWith("http.https://github.com/.extraHeader=Authorization:"),
      ),
    ).toBe(true);
    expect(pushArgs).toEqual(["-c", "credential.helper="]);
    const scopedHeader = fetchArgs[3];
    expect(
      (await runGit(WORK, [
        "-c",
        scopedHeader,
        "config",
        "--get-urlmatch",
        "http.extraHeader",
        "https://github.com/me/repo.git",
      ])).stdout.trim(),
    ).toMatch(/^Authorization: Basic /);
    await expect(
      runGit(WORK, [
        "-c",
        scopedHeader,
        "config",
        "--get-urlmatch",
        "http.extraHeader",
        "https://github.com.evil.example/steal.git",
      ]),
    ).rejects.toThrow();

    await runGit(WORK, ["remote", "set-url", "origin", "https://gitlab.com/me/repo.git"]);
    expect(await authArgsForRemote(WORK, "secret-token", "origin", false)).toEqual([
      "-c",
      "credential.helper=",
    ]);
  });

  it("uses the only configured remote for a branch's first push when origin does not exist", async () => {
    await fs.mkdir(BASE, { recursive: true });
    await runGit(BASE, ["init", "--bare", "company.git"]);
    await fs.mkdir(WORK, { recursive: true });
    await runGit(WORK, ["init", "-b", "main"]);
    await runGit(WORK, ["config", "user.email", "t@example.com"]);
    await runGit(WORK, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(WORK, "a.txt"), "one\n", "utf8");
    await runGit(WORK, ["add", "-A"]);
    await runGit(WORK, ["commit", "-m", "first"]);
    await runGit(WORK, ["remote", "add", "company", path.join(BASE, "company.git")]);

    const res = await push(WORK);

    expect(res.rejected).toBeUndefined();
    expect(await revParse(path.join(BASE, "company.git"), "main")).toBe(
      await revParse(WORK, "HEAD"),
    );
    expect((await runGit(WORK, ["rev-parse", "--abbrev-ref", "main@{upstream}"])).stdout.trim()).toBe(
      "company/main",
    );
  });

  it("does not guess a destination when a new branch has multiple non-origin remotes", async () => {
    await fs.mkdir(BASE, { recursive: true });
    await runGit(BASE, ["init", "--bare", "one.git"]);
    await runGit(BASE, ["init", "--bare", "two.git"]);
    await fs.mkdir(WORK, { recursive: true });
    await runGit(WORK, ["init", "-b", "main"]);
    await runGit(WORK, ["config", "user.email", "t@example.com"]);
    await runGit(WORK, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(WORK, "a.txt"), "one\n", "utf8");
    await runGit(WORK, ["add", "-A"]);
    await runGit(WORK, ["commit", "-m", "first"]);
    await runGit(WORK, ["remote", "add", "one", path.join(BASE, "one.git")]);
    await runGit(WORK, ["remote", "add", "two", path.join(BASE, "two.git")]);

    await expect(push(WORK)).rejects.toMatchObject({ status: 409 });
    await expect(revParse(path.join(BASE, "one.git"), "main")).rejects.toThrow();
    await expect(revParse(path.join(BASE, "two.git"), "main")).rejects.toThrow();
  });

  it("reports a non-fast-forward rejection instead of throwing", async () => {
    await setupAmended();
    const res = await push(WORK);
    expect(res.rejected).toBe(true);
    expect(res.branch).toBe("main");
    expect(res.upstream).toBe("origin/main");
    // The remote still holds the original commit — nothing was overwritten.
    expect(await revParse(ORIGIN, "main")).not.toBe(await revParse(WORK, "HEAD"));
  });

  it("overwrites the remote when forced with a lease", async () => {
    await setupAmended();
    const res = await push(WORK, { force: "lease" });
    expect(res.rejected).toBeUndefined();
    // Origin now points at the amended local commit.
    expect(await revParse(ORIGIN, "main")).toBe(await revParse(WORK, "HEAD"));
  });

  it("overwrites the remote when forced without a lease", async () => {
    await setupAmended();
    const res = await push(WORK, { force: "force" });
    expect(res.rejected).toBeUndefined();
    expect(await revParse(ORIGIN, "main")).toBe(await revParse(WORK, "HEAD"));
  });

  it("refuses a with-lease force push when the remote advanced unseen (protects unpulled work)", async () => {
    const { theirHead } = await setupRemoteAdvanced();

    const rejected = await push(WORK);
    expect(rejected.rejected).toBe(true);

    // force-with-lease must REFUSE here — origin moved in ways work1 never saw —
    // so the teammate's commit is not silently clobbered.
    await expect(push(WORK, { force: "lease" })).rejects.toMatchObject({ status: 409 });
    expect(await revParse(ORIGIN, "main")).toBe(theirHead);
  });

  it("overwrites an unseen remote advance when forced without a lease", async () => {
    // The deliberate escape hatch: bare --force has no lease to verify, so it
    // clobbers the teammate's commit. That's exactly why it's a separate button.
    const { theirHead } = await setupRemoteAdvanced();

    const res = await push(WORK, { force: "force" });
    expect(res.rejected).toBeUndefined();
    expect(await revParse(ORIGIN, "main")).toBe(await revParse(WORK, "HEAD"));
    expect(await revParse(ORIGIN, "main")).not.toBe(theirHead);
  });

  it("pushes cleanly when the branch is a fast-forward", async () => {
    await setupAmended();
    await push(WORK, { force: "lease" }); // sync origin to local
    await fs.writeFile(path.join(WORK, "a.txt"), "one\ntwo\nthree\n", "utf8");
    await runGit(WORK, ["commit", "-am", "third"]);

    const res = await push(WORK);
    expect(res.rejected).toBeUndefined();
    expect(await revParse(ORIGIN, "main")).toBe(await revParse(WORK, "HEAD"));
  });
});

describe("pull", () => {
  it("merges divergent work even when the host config requests rebase", async () => {
    await fs.mkdir(BASE, { recursive: true });
    await runGit(BASE, ["init", "--bare", "origin.git"]);
    await fs.mkdir(WORK, { recursive: true });
    await runGit(WORK, ["init", "-b", "main"]);
    await runGit(WORK, ["config", "user.email", "t@example.com"]);
    await runGit(WORK, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(WORK, "base.txt"), "base\n", "utf8");
    await runGit(WORK, ["add", "-A"]);
    await runGit(WORK, ["commit", "-m", "base"]);
    await runGit(WORK, ["remote", "add", "origin", ORIGIN]);
    await runGit(WORK, ["push", "-u", "origin", "main"]);

    const other = path.join(BASE, "other");
    await runGit(BASE, ["clone", ORIGIN, "other"]);
    await runGit(other, ["config", "user.email", "o@example.com"]);
    await runGit(other, ["config", "user.name", "Other"]);
    await fs.writeFile(path.join(other, "theirs.txt"), "theirs\n", "utf8");
    await runGit(other, ["add", "-A"]);
    await runGit(other, ["commit", "-m", "theirs"]);
    await runGit(other, ["push", "origin", "main"]);

    await fs.writeFile(path.join(WORK, "mine.txt"), "mine\n", "utf8");
    await runGit(WORK, ["add", "-A"]);
    await runGit(WORK, ["commit", "-m", "mine"]);
    const localBefore = await revParse(WORK, "HEAD");
    const remoteBefore = await revParse(ORIGIN, "main");
    await runGit(WORK, ["config", "pull.rebase", "true"]);

    await pull(WORK);

    const parents = (await runGit(WORK, ["rev-list", "--parents", "-n", "1", "HEAD"]))
      .stdout.trim().split(" ").slice(1);
    expect(parents).toEqual([localBefore, remoteBefore]);
  });

  it("returns and pulls the exact first-push target after an untracked branch is rejected", async () => {
    const { theirHead } = await setupRemoteAdvanced();
    await runGit(WORK, ["branch", "--unset-upstream"]);

    const rejected = await push(WORK);

    expect(rejected).toMatchObject({
      rejected: true,
      branch: "main",
      upstream: null,
      remote: "origin",
      remoteBranch: "main",
    });
    await pull(WORK, { remote: rejected.remote!, branch: rejected.remoteBranch! });
    await expect(runGit(WORK, ["rev-parse", "main@{upstream}"])).rejects.toThrow();
    await runGit(WORK, ["merge-base", "--is-ancestor", theirHead, "HEAD"]);

    const pushed = await push(WORK);
    expect(pushed.rejected).toBeUndefined();
    expect((await runGit(WORK, ["rev-parse", "--abbrev-ref", "main@{upstream}"])).stdout.trim()).toBe(
      "origin/main",
    );
    expect(await revParse(ORIGIN, "main")).toBe(await revParse(WORK, "HEAD"));
  });

  it("refuses a stale targeted pull after the checked-out branch changes", async () => {
    await setupAmended();
    await runGit(WORK, ["checkout", "-b", "other"]);

    await expect(pull(WORK, { remote: "origin", branch: "main" })).rejects.toMatchObject({
      status: 409,
    });
    expect(await revParse(WORK, "HEAD")).toBe(await revParse(WORK, "other"));
  });
});

describe("deleteRemoteBranch", () => {
  it("removes the branch on the remote and its tracking ref", async () => {
    await setupAmended();
    await runGit(WORK, ["checkout", "-b", "feature"]);
    await runGit(WORK, ["push", "-u", "origin", "feature"]);
    expect(await revParse(ORIGIN, "feature")).toBeTruthy();

    await deleteRemoteBranch(WORK, "origin", "feature");

    await expect(revParse(ORIGIN, "feature")).rejects.toThrow();
    const remaining = await getRemoteBranches(WORK);
    expect(remaining.map((b) => b.name)).not.toContain("origin/feature");
  });

  it("rejects names that could be read as flags", async () => {
    await setupAmended();
    await expect(deleteRemoteBranch(WORK, "origin", "--mirror")).rejects.toMatchObject({
      status: 400,
    });
    await expect(deleteRemoteBranch(WORK, "", "main")).rejects.toMatchObject({ status: 400 });
  });
});
