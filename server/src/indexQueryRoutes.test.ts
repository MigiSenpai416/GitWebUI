import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { api, apiErrorHandler } from "./routes.js";
import { openRepo } from "./git/repo.js";
import { runGit } from "./git/gitRunner.js";
import { registerRepo, unregisterRepo } from "./session.js";

const TMP = path.join(os.tmpdir(), `gitwebui-indexroutes-${randomBytes(6).toString("hex")}`);
let server: Server;
let base = "";
let root = "";

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
  await runGit(TMP, ["init", "-b", "main"]);
  await runGit(TMP, ["config", "user.name", "Test User"]);
  await runGit(TMP, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(TMP, "first.txt"), "first\n");
  await runGit(TMP, ["add", "-A"]);
  await runGit(TMP, ["commit", "-m", "base"]);
  root = registerRepo(await openRepo(TMP)).root;
  const app = express();
  app.use(express.json());
  app.use("/api", api);
  app.use("/api", apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  unregisterRepo(root);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("index query routes", () => {
  it("returns fresh status after unstaging both sides of a rename and preserves working content", async () => {
    await runGit(TMP, ["mv", "first.txt", "renamed [x].txt"]);
    await fs.writeFile(path.join(TMP, "renamed [x].txt"), "unstaged content\n");
    const response = await fetch(base + "/api/unstage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Repo-Root": root },
      body: JSON.stringify({ paths: ["renamed [x].txt"] }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
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
    const state = await fetch(base + "/api/merge/state", { headers: { "X-Repo-Root": root } });
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toMatchObject({
      merge: { active: true, conflicted: ["conflict [x].txt"] },
    });
    const resolved = await fetch(base + "/api/conflict/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Repo-Root": root },
      body: JSON.stringify({ path: "conflict [x].txt", content: "resolved\n", resolved: true }),
    });
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({
      merge: { active: false, conflicted: [] },
      status: { staged: [{ path: "conflict [x].txt", status: "A", staged: true }] },
    });
    expect((await runGit(TMP, ["ls-files", "--unmerged", "-z"])).stdout).toBe("");
    expect((await runGit(TMP, ["show", ":conflict [x].txt"])).stdout).toBe("resolved\n");
  });
});
