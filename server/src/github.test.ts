import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

const TMP = path.join(os.tmpdir(), `gitwebui-gh-test-${randomBytes(6).toString("hex")}`);
process.env.GITWEBUI_CONFIG_DIR = TMP;

const { getToken, setToken, deleteToken, hasToken, listRepos, _resetTokenCache } = await import("./github.js");

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  _resetTokenCache();
});
afterAll(() => fs.rm(TMP, { recursive: true, force: true }));

describe("token storage", () => {
  it("has no token before one is set", async () => {
    expect(await hasToken()).toBe(false);
    expect(await getToken()).toBeNull();
  });

  it("stores, reads, and deletes the token", async () => {
    await setToken("ghp_example");
    expect(await hasToken()).toBe(true);
    expect(await getToken()).toBe("ghp_example");

    // Persisted to disk and re-readable after a cache reset.
    _resetTokenCache();
    expect(await getToken()).toBe("ghp_example");

    await deleteToken();
    expect(await hasToken()).toBe(false);
    expect(await getToken()).toBeNull();
  });
});

describe("listRepos", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  function repoPayload(fullName: string, priv: boolean) {
    const [owner, name] = fullName.split("/");
    return {
      full_name: fullName,
      name,
      owner: { login: owner },
      private: priv,
      clone_url: `https://github.com/${fullName}.git`,
      description: priv ? "secret" : null,
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  it("paginates and maps owned + private repos", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => repoPayload(`me/repo${i}`, i % 2 === 0));
    const page2 = [repoPayload("org/last-private", true)];
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      const body = String(url).includes("page=2") ? page2 : page1;
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    }) as unknown as typeof fetch;

    const repos = await listRepos("ghp_x");
    // Two pages fetched (page1 full → keep going, page2 short → stop).
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("affiliation=owner,collaborator,organization_member");
    expect(repos).toHaveLength(101);
    expect(repos[0]).toEqual({
      fullName: "me/repo0",
      name: "repo0",
      owner: "me",
      private: true,
      cloneUrl: "https://github.com/me/repo0.git",
      description: "secret",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(repos.some((r) => r.fullName === "org/last-private" && r.private)).toBe(true);
  });
});
