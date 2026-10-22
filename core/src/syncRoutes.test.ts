import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dispatch, errorMessage, errorStatus } from "./api.js";
import { runGit } from "./git/gitRunner.js";
import { openRepo } from "./git/repo.js";
import { registerRepo, unregisterRepo } from "./session.js";

const BASE = path.join(os.tmpdir(), `gitwebui-sync-routes-${randomBytes(6).toString("hex")}`);
const ORIGIN = path.join(BASE, "origin.git");
const WORK = path.join(BASE, "work");
let repoRoot = "";

async function revParse(root: string, ref: string): Promise<string> {
  return (await runGit(root, ["rev-parse", ref])).stdout.trim();
}

/** Make one call the way the main process does, JSON round-trip included. */
async function call(route: string, root: string, input: Record<string, unknown> = {}) {
  try {
    const result = await dispatch(route, input, { root, signal: new AbortController().signal });
    return { status: 200, body: JSON.parse(JSON.stringify(result)) };
  } catch (e) {
    return { status: errorStatus(e), body: { error: errorMessage(e) } };
  }
}

beforeAll(async () => {
  await fs.mkdir(BASE, { recursive: true });
  await runGit(BASE, ["init", "--bare", "origin.git"]);
  await fs.mkdir(WORK, { recursive: true });
  await runGit(WORK, ["init", "-b", "main"]);
  await runGit(WORK, ["config", "user.name", "Test User"]);
  await runGit(WORK, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(WORK, "base.txt"), "base\n", "utf8");
  await runGit(WORK, ["add", "-A"]);
  await runGit(WORK, ["commit", "-m", "base"]);
  await runGit(WORK, ["remote", "add", "origin", ORIGIN]);
  await runGit(WORK, ["push", "-u", "origin", "main"]);
  await runGit(ORIGIN, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const opened = registerRepo(await openRepo(WORK));
  repoRoot = opened.root;
});

afterAll(async () => {
  unregisterRepo(repoRoot);
  await fs.rm(BASE, { recursive: true, force: true });
});

describe("pull", () => {
  it("returns refreshed repository metadata after pull moves HEAD", async () => {
    const oldHead = await revParse(WORK, "HEAD");
    const other = path.join(BASE, "other");
    await runGit(BASE, ["clone", ORIGIN, "other"]);
    await runGit(other, ["config", "user.name", "Other User"]);
    await runGit(other, ["config", "user.email", "other@example.com"]);
    await fs.writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
    await runGit(other, ["add", "-A"]);
    await runGit(other, ["commit", "-m", "remote update"]);
    await runGit(other, ["push", "origin", "main"]);
    const newHead = await revParse(ORIGIN, "main");
    expect(newHead).not.toBe(oldHead);

    const response = await call("pull", repoRoot);

    expect(response).toMatchObject({
      status: 200,
      body: {
        repo: { root: repoRoot, branch: "main", head: newHead },
        merge: { active: false },
      },
    });
  });
});
