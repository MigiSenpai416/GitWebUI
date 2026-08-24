import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { api, apiErrorHandler } from "./routes.js";
import { runGit } from "./git/gitRunner.js";
import { openRepo } from "./git/repo.js";
import { registerRepo, unregisterRepo } from "./session.js";

const BASE = path.join(os.tmpdir(), `gitwebui-sync-routes-${randomBytes(6).toString("hex")}`);
const ORIGIN = path.join(BASE, "origin.git");
const WORK = path.join(BASE, "work");
let server: Server;
let baseUrl = "";
let repoRoot = "";

async function revParse(root: string, ref: string): Promise<string> {
  return (await runGit(root, ["rev-parse", ref])).stdout.trim();
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

  const app = express();
  app.use(express.json());
  app.use("/api", api);
  app.use("/api", apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  unregisterRepo(repoRoot);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(BASE, { recursive: true, force: true });
});

describe("POST /pull", () => {
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

    const response = await fetch(baseUrl + "/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Repo-Root": repoRoot },
      body: "{}",
    });

    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 200,
      body: {
        repo: { root: repoRoot, branch: "main", head: newHead },
        merge: { active: false },
      },
    });
  });
});
