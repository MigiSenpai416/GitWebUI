import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

const TMP = path.join(os.tmpdir(), `gitwebui-gh-test-${randomBytes(6).toString("hex")}`);
process.env.GITWEBUI_CONFIG_DIR = TMP;

const {
  getToken,
  setToken,
  deleteToken,
  hasToken,
  listRepos,
  parseGitHubSlug,
  createPullRequest,
  _resetTokenCache,
} = await import("./github.js");

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

describe("parseGitHubSlug", () => {
  it("reads owner/repo from every clone URL form", () => {
    expect(parseGitHubSlug("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubSlug("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubSlug("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubSlug("git@github.com:owner/My.Repo.git")).toEqual({ owner: "owner", repo: "My.Repo" });
    expect(parseGitHubSlug("ssh://git@github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubSlug("git://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubSlug("https://user:tok@www.github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("rejects non-GitHub and malformed remotes", () => {
    expect(parseGitHubSlug("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseGitHubSlug("git@bitbucket.org:owner/repo.git")).toBeNull();
    expect(parseGitHubSlug("https://github.com/owner")).toBeNull();
    expect(parseGitHubSlug("C:\\repos\\local")).toBeNull();
    expect(parseGitHubSlug("")).toBeNull();
  });
});

describe("createPullRequest", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("posts to the base repo and keeps a fork's head qualified", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return {
        ok: true,
        status: 201,
        json: async () => ({ number: 7, html_url: "https://github.com/up/repo/pull/7", title: "t" }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const pr = await createPullRequest("ghp_x", {
      owner: "up",
      repo: "repo",
      title: "t",
      body: "why",
      head: "me:feature",
      base: "main",
      draft: true,
    });

    expect(pr).toEqual({ number: 7, htmlUrl: "https://github.com/up/repo/pull/7", title: "t" });
    expect(seen!.url).toBe("https://api.github.com/repos/up/repo/pulls");
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      title: "t",
      body: "why",
      head: "me:feature",
      base: "main",
      draft: true,
    });
  });

  it("surfaces the validation detail rather than 'Validation Failed'", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      json: async () => ({}),
      text: async () =>
        JSON.stringify({
          message: "Validation Failed",
          errors: [{ message: "No commits between main and dev" }],
        }),
    })) as unknown as typeof fetch;

    await expect(
      createPullRequest("ghp_x", {
        owner: "me",
        repo: "repo",
        title: "t",
        body: "",
        head: "dev",
        base: "main",
        draft: false,
      }),
    ).rejects.toThrow("No commits between main and dev");
  });
});
