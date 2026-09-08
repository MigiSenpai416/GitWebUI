import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommitsByHash, searchCommits } from "./log.js";
import { runGit } from "./gitRunner.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gitwebui-commit-search-"));
  await runGit(root, ["init", "-b", "main"]);
  await runGit(root, ["config", "user.name", "Search Author"]);
  await runGit(root, ["config", "user.email", "search@example.com"]);
  await runGit(root, ["config", "commit.gpgsign", "false"]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function commit(message: string) {
  await runGit(root, ["commit", "--allow-empty", "-m", message]);
  return (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("repository commit search", () => {
  it("searches full descriptions and every branch, remote, tag, and detached HEAD literally", async () => {
    const body = await commit("Ordinary title\n\nFirst paragraph\n\nDeep NEEDLE [x] description");
    const miss = await commit("needle x is not a literal bracket match");
    await runGit(root, ["checkout", "-b", "hidden", body]);
    const branch = await commit("Needle [x] on a hidden branch");
    await runGit(root, ["checkout", "--detach", body]);
    const remote = await commit("needle [x] remote only");
    await runGit(root, ["update-ref", "refs/remotes/origin/hidden", remote]);
    await runGit(root, ["checkout", "--detach", body]);
    const tag = await commit("needle [x] tag only");
    await runGit(root, ["tag", "-a", "release", "-m", "release", tag]);
    await runGit(root, ["checkout", "--detach", body]);
    const detached = await commit("needle [x] detached");
    const result = await searchCommits(root, "needle [x]");
    expect(new Set(result.matches.map((index) => result.rows[index].hash))).toEqual(new Set([body, branch, remote, tag, detached]));
    expect(result.rows.map((row) => row.hash)).toContain(miss);
    expect(new Set(result.rows.map((row) => row.hash)).size).toBe(result.rows.length);
    const details = await getCommitsByHash(root, [body, tag]);
    expect(details.map((entry) => entry.hash)).toEqual([body, tag]);
    expect(details[0].body).toContain("Deep NEEDLE [x] description");
  });

  it("does not search author names or notes and accepts flag-like literal text", async () => {
    const hash = await commit("Keep --all as literal text");
    await runGit(root, ["notes", "add", "-m", "note-only-token", hash]);
    await runGit(root, ["config", "log.showNotes", "true"]);
    expect((await searchCommits(root, "--all")).matches).toEqual([0]);
    expect((await searchCommits(root, "Search Author")).matches).toEqual([]);
    expect((await searchCommits(root, "note-only-token")).matches).toEqual([]);
  });

  it("handles an empty repository and an unborn branch with history on other refs", async () => {
    expect(await searchCommits(root, "needle")).toEqual({ rows: [], matches: [] });
    const hash = await commit("needle");
    await runGit(root, ["checkout", "--orphan", "unborn"]);
    const result = await searchCommits(root, "needle");
    expect(result.matches.map((index) => result.rows[index].hash)).toEqual([hash]);
  });

  it("keeps batch metadata clean when signature and note display are enabled", async () => {
    const parent = await commit("parent");
    const tree = (await runGit(root, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const raw = `tree ${tree}\nparent ${parent}\nauthor Search Author <search@example.com> 1600000000 +0000\ncommitter Search Author <search@example.com> 1600000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n bogus\n -----END PGP SIGNATURE-----\n\nneedle title\n\nneedle body\n`;
    const hash = (await runGit(root, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: raw })).stdout.trim();
    await runGit(root, ["config", "log.showSignature", "true"]);
    await runGit(root, ["config", "log.showNotes", "true"]);
    await runGit(root, ["notes", "add", "-m", "note-only-token", hash]);
    const result = await getCommitsByHash(root, [hash, parent]);
    expect(result.map((entry) => entry.hash)).toEqual([hash, parent]);
    expect(result[0].subject).toBe("needle title");
    expect(result[0].body).toBe("needle body");
  });

  it("preserves cancellation for search and batch reads", async () => {
    const hash = await commit("needle");
    const controller = new AbortController();
    controller.abort();
    await expect(searchCommits(root, "needle", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(getCommitsByHash(root, [hash], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
