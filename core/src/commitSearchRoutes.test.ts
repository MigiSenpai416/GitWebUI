import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./api.js";
import * as log from "./git/log.js";
import * as commitFiles from "./git/commitFiles.js";
import { registerRepo, unregisterRepo } from "./session.js";

const root = "commit-search-cancellation-fixture";
const hash = "a".repeat(40);

beforeAll(() => {
  registerRepo({ root, branch: "main", head: hash });
});

afterAll(() => {
  unregisterRepo(root);
});

describe("commit search call cancellation", () => {
  it.each(["search", "batch", "files"])("aborts the %s Git read when its caller gives up", async (kind) => {
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
    const [route, input]: [string, Record<string, unknown>] = kind === "search" ? ["searchCommits", { q: "needle" }] :
      kind === "batch" ? ["commitsByHash", { hashes: [hash] }] : ["commitFiles", { hash }];
    try {
      const result = dispatch(route, input, { root, signal: controller.signal });
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
