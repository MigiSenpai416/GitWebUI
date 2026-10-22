import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dispatch, errorMessage, errorStatus } from "./api.js";
import { openRepo } from "./git/repo.js";
import { runGit } from "./git/gitRunner.js";
import { registerRepo, unregisterRepo } from "./session.js";

const TMP = path.join(os.tmpdir(), `gitwebui-indexroutes-${randomBytes(6).toString("hex")}`);
let root = "";

/** Make one call the way the main process does, JSON round-trip included. */
async function call(route: string, input: Record<string, unknown> = {}) {
  try {
    const result = await dispatch(route, input, { root, signal: new AbortController().signal });
    return { status: 200, body: JSON.parse(JSON.stringify(result)) };
  } catch (e) {
    return { status: errorStatus(e), body: { error: errorMessage(e) } };
  }
}

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
  await runGit(TMP, ["init", "-b", "main"]);
  await runGit(TMP, ["config", "user.name", "Test User"]);
  await runGit(TMP, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(TMP, "first.txt"), "first\n");
  await runGit(TMP, ["add", "-A"]);
  await runGit(TMP, ["commit", "-m", "base"]);
  root = registerRepo(await openRepo(TMP)).root;
});

afterAll(async () => {
  unregisterRepo(root);
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("index query routes", () => {
  it("returns fresh status after unstaging both sides of a rename and preserves working content", async () => {
    await runGit(TMP, ["mv", "first.txt", "renamed [x].txt"]);
    await fs.writeFile(path.join(TMP, "renamed [x].txt"), "unstaged content\n");
    const response = await call("unstage", { paths: ["renamed [x].txt"] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      staged: [],
      unstaged: [
        { path: "first.txt", status: "D", staged: false },
        { path: "renamed [x].txt", status: "?", staged: false },
      ],
    });
    expect((await runGit(TMP, ["diff", "--cached", "--name-only"])).stdout).toBe("");
    expect(await fs.readFile(path.join(TMP, "renamed [x].txt"), "utf8")).toBe("unstaged content\n");
  });

  it("reports an index conflict once and clears it after resolving through the API", async () => {
    const blob = (await runGit(TMP, ["hash-object", "-w", "--stdin"], { input: "conflict\n" })).stdout.trim();
    await runGit(TMP, ["update-index", "-z", "--index-info"], {
      input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tconflict [x].txt\0`).join(""),
    });
    const state = await call("mergeState");
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      merge: { active: true, conflicted: ["conflict [x].txt"] },
    });
    const resolved = await call("resolveConflict", {
      path: "conflict [x].txt",
      content: "resolved\n",
      resolved: true,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      merge: { active: false, conflicted: [] },
      status: { staged: [{ path: "conflict [x].txt", status: "A", staged: true }] },
    });
    expect((await runGit(TMP, ["ls-files", "--unmerged", "-z"])).stdout).toBe("");
    expect((await runGit(TMP, ["show", ":conflict [x].txt"])).stdout).toBe("resolved\n");
  });
});
