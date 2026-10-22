import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dispatch, errorMessage, errorStatus } from "./api.js";
import * as mutate from "./git/mutate.js";
import { isRepoMaintenanceActive } from "./git/historyFiles.js";
import { openRepo } from "./git/repo.js";
import { runGit } from "./git/gitRunner.js";
import { getRepoByRoot, registerRepo, unregisterRepo } from "./session.js";
import { pickShell, type RunEvent } from "./terminal.js";

const TMP = path.join(os.tmpdir(), `gitwebui-api-${randomBytes(6).toString("hex")}`);
let root = "";

/** Make one call the way the main process does, JSON round-trip included. */
async function call(route: string, input: unknown = {}, signal = new AbortController().signal) {
  try {
    const result = await dispatch(route, input, { root, signal });
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

describe("dispatch", () => {
  it("reports an unknown route, including inherited object keys, as 404", async () => {
    for (const route of ["not-a-route", "constructor", "toString"]) {
      expect(await call(route)).toEqual({ status: 404, body: { error: `Unknown operation: ${route}` } });
    }
  });

  it("treats a missing or non-object input as an empty one", async () => {
    for (const input of [null, undefined, "path", ["path"]]) {
      expect(await call("openRepo", input)).toEqual({
        status: 400,
        body: { error: "A repository path is required" },
      });
    }
  });

  it("registers a repository the registry has not seen before running the call", async () => {
    unregisterRepo(root);
    expect(getRepoByRoot(root)).toBeUndefined();

    const status = await call("status");
    expect(status).toEqual({ status: 200, body: { staged: [], unstaged: [] } });
    expect(getRepoByRoot(root)).toMatchObject({ root, branch: "main" });

    const missing = await dispatch("status", {}, {
      root: path.join(TMP, "not-a-repository"),
      signal: new AbortController().signal,
    }).catch((e: unknown) => ({ status: errorStatus(e), error: errorMessage(e) }));
    expect(missing).toEqual({ status: 409, error: "No repository is open" });
  });
});

describe("repository maintenance", () => {
  it("refuses writes while it runs, still serves reads, and leaves no reservation behind", async () => {
    const pruning = call("pruneRepo");
    expect(isRepoMaintenanceActive(root)).toBe(true);
    const refused = call("stage", { all: true });
    const read = call("status");
    expect(await refused).toEqual({
      status: 409,
      body: { error: "Repository maintenance is running for this repository" },
    });
    expect(await read).toEqual({ status: 200, body: { staged: [], unstaged: [] } });
    expect(await pruning).toEqual({ status: 200, body: { ok: true } });

    // A refused write must not have reserved the repository, or pruning again
    // would report other operations as still running.
    expect(await call("pruneRepo")).toEqual({ status: 200, body: { ok: true } });
  });

  it("holds a write's reservation until its handler settles, success or failure", async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const spy = vi.spyOn(mutate, "stageAll").mockImplementation(() => blocked);
    try {
      const staging = call("stage", { all: true });
      expect(await call("pruneRepo")).toMatchObject({
        status: 409,
        body: { error: expect.stringContaining("other repository operations") },
      });
      finish();
      expect(await staging).toMatchObject({ status: 200 });
    } finally {
      spy.mockRestore();
    }

    expect(await call("merge", { branch: "feature", strategy: "squash" })).toEqual({
      status: 400,
      body: { error: "A valid merge strategy is required" },
    });
    expect(await call("pruneRepo")).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("terminalRun", () => {
  const shell = pickShell(undefined);
  const isPs = shell.kind === "powershell" || shell.kind === "pwsh";

  it("streams the command's output through emit and resolves once it exits", async () => {
    const events: RunEvent[] = [];
    const result = await dispatch("terminalRun", { command: "echo hello-from-dispatch" }, {
      root,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
    });
    expect(result).toEqual({ ok: true });
    expect(events.filter((e) => e.t === "out").map((e) => e.d).join("")).toContain("hello-from-dispatch");
    expect(events.at(-1)).toMatchObject({ t: "exit", code: 0, killed: false });
  });

  it("kills the command when the call is aborted", async () => {
    const events: RunEvent[] = [];
    const controller = new AbortController();
    const run = dispatch("terminalRun", { command: isPs ? "Start-Sleep -Seconds 30" : "sleep 30" }, {
      root,
      signal: controller.signal,
      emit: (e) => events.push(e),
    });
    setTimeout(() => controller.abort(), 250);
    expect(await run).toEqual({ ok: true });
    expect(events.at(-1)).toMatchObject({ t: "exit", killed: true });
  }, 20000);

  it("refuses an empty command", async () => {
    expect(await call("terminalRun", { command: "  " })).toEqual({
      status: 400,
      body: { error: "Nothing to run" },
    });
  });
});
