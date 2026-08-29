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

const TMP = path.join(os.tmpdir(), `gitwebui-reporoutes-${randomBytes(6).toString("hex")}`);
let server: Server;
let base = "";

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
  await runGit(TMP, ["init", "-b", "main"]);
  await runGit(TMP, ["config", "user.name", "Test User"]);
  await runGit(TMP, ["config", "user.email", "test@example.com"]);
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
  // Git normalizes the registered root (notably path separators on Windows).
  unregisterRepo((await openRepo(TMP)).root);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("GET /repo/current", () => {
  it("re-reads branch metadata changed outside GitWebUI", async () => {
    const opened = registerRepo(await openRepo(TMP));
    expect(opened.branch).toBe("main");

    // Model a branch switch performed in the built-in terminal or another Git
    // client. The registered object still says main until the refresh route is
    // called.
    await runGit(TMP, ["branch", "-m", "outside-change"]);

    const res = await fetch(base + "/api/repo/current", {
      headers: { "X-Repo-Root": opened.root },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      repo: { root: opened.root, branch: "outside-change", head: null },
    });
  });
});

describe("POST /commit", () => {
  it("refreshes an unborn repository so its first commit is immediately listed", async () => {
    const opened = registerRepo(await openRepo(TMP));
    expect(opened.head).toBeNull();
    await fs.writeFile(path.join(TMP, "first.txt"), "first\n", "utf8");
    await runGit(TMP, ["add", "--", "first.txt"]);

    const committed = await fetch(base + "/api/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Repo-Root": opened.root },
      body: JSON.stringify({ title: "first commit", description: "first body", amend: false }),
    });
    expect(committed.status).toBe(200);
    const result = await committed.json() as {
      hash: string;
      repo: { head: string | null };
    };
    expect(result.repo.head).toBe(result.hash);

    const listed = await fetch(base + "/api/commits?skip=0&limit=10", {
      headers: { "X-Repo-Root": opened.root },
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      commits: [{ hash: result.hash, subject: "first commit", body: "first body" }],
      hasMore: false,
    });
  });
});

describe("history rewrite mutation reservations", () => {
  it("releases unmatched mutations and exempts the trailing-slash delete route", async () => {
    const opened = registerRepo(await openRepo(TMP));
    const unmatched = await fetch(base + "/api/not-a-route", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Repo-Root": opened.root },
      body: "{}",
    });
    expect(unmatched.status).toBe(404);

    const head = (await runGit(TMP, ["rev-parse", "HEAD"])).stdout.trim();
    const deletion = await fetch(base + "/api/history-files/delete/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Repo-Root": opened.root },
      body: JSON.stringify({
        path: "does-not-exist.txt",
        expectedHead: head,
        confirmation: "does-not-exist.txt",
      }),
    });
    expect(deletion.status).toBe(409);
    await expect(deletion.json()).resolves.toMatchObject({
      error: expect.stringContaining("no longer exists in reachable history"),
    });
  });
});
