import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { api, apiErrorHandler } from "./routes.js";
import * as log from "./git/log.js";
import * as commitFiles from "./git/commitFiles.js";
import { registerRepo, unregisterRepo } from "./session.js";

const root = "commit-search-cancellation-fixture";
const hash = "a".repeat(40);
let server: Server;
let base = "";

beforeAll(async () => {
  registerRepo({ root, branch: "main", head: hash });
  const app = express();
  app.use("/api", api);
  app.use("/api", apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  unregisterRepo(root);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("commit search request cancellation", () => {
  it.each(["search", "batch", "files"])("aborts the %s Git read when its client disconnects", async (kind) => {
    let ready!: () => void;
    let cancelled!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const stopped = new Promise<void>((resolve) => { cancelled = resolve; });
    const wait = (_root: string, _query: unknown, signal?: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
      expect(signal).toBeDefined();
      signal!.addEventListener("abort", () => {
        cancelled();
        reject(signal!.reason);
      }, { once: true });
      ready();
    });
    const spy = kind === "search" ? vi.spyOn(log, "searchCommits").mockImplementation(wait) :
      kind === "batch" ? vi.spyOn(log, "getCommitsByHash").mockImplementation(wait) :
      vi.spyOn(commitFiles, "getCommitFiles").mockImplementation(wait);
    const controller = new AbortController();
    const url = kind === "search" ? "/commits/search?q=needle" :
      kind === "batch" ? `/commits/batch?hashes=${hash}` : `/commits/${hash}/files`;
    try {
      const result = fetch(base + "/api" + url, { headers: { "X-Repo-Root": root }, signal: controller.signal });
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await started;
      controller.abort();
      await rejected;
      await stopped;
    } finally {
      controller.abort();
      spy.mockRestore();
    }
  });
});
