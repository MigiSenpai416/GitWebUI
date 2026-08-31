import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
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
  beginOAuthDeviceFlow,
  pollOAuthDeviceFlow,
  cancelOAuthDeviceFlow,
  status,
  _resetTokenCache,
} = await import("./github.js");

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  _resetTokenCache();
});
afterAll(() => fs.rm(TMP, { recursive: true, force: true }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

describe("OAuth Device Flow", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("uses the built-in Client ID", async () => {
    const clientIds: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      clientIds.push(new URLSearchParams(String(init?.body)).get("client_id") ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      };
    }) as unknown as typeof fetch;

    cancelOAuthDeviceFlow((await beginOAuthDeviceFlow()).flowId);
    expect(clientIds).toEqual(["Ov23liu2LXjA3dklsGu1"]);
  });

  it("keeps the device secret server-side and stores the authorized OAuth token", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls: Array<{ url: string; body: string; signal: AbortSignal | null }> = [];
    let tokenPolls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body ?? ""),
        signal: init?.signal ?? null,
      });
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "server-only-device-secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        tokenPolls++;
        return {
          ok: true,
          status: 200,
          json: async () => tokenPolls === 1
            ? { error: "authorization_pending" }
            : { access_token: "gho_authorized", scope: "repo,user:email", token_type: "bearer" },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: "octocat",
          name: "The Octocat",
          avatar_url: null,
          id: 1,
          email: null,
        }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    expect(flow).toMatchObject({
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      intervalMs: 1_000,
    });
    expect(flow).not.toHaveProperty("deviceCode");
    expect(calls[0].body).toContain("scope=repo+user%3Aemail");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);

    now = 2_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toEqual({
      status: "pending",
      retryAfterMs: 1_000,
    });
    now = 3_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toEqual({
      status: "complete",
      user: {
        login: "octocat",
        name: "The Octocat",
        avatarUrl: null,
        id: 1,
        email: null,
      },
    });
    expect(calls[1].body).toContain("device_code=server-only-device-secret");
    expect(calls.filter((call) => call.url.includes("/login/oauth/access_token"))[0].signal)
      .toBeInstanceOf(AbortSignal);
    expect(calls.find((call) => call.url === "https://api.github.com/user")?.signal)
      .toBeInstanceOf(AbortSignal);
    expect(await getToken()).toBe("gho_authorized");
    expect(await status()).toMatchObject({ configured: true, authMethod: "oauth" });
  });

  it("stops a cancelled flow before it can be polled", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        device_code: "secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    })) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    cancelOAuthDeviceFlow(flow.flowId);
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({ status: "expired" });
  });

  it("rolls back an OAuth credential commit cancelled while its file write is in flight", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("ghp_previous");
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_cancelled", scope: "repo,user:email" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: "octocat",
          name: null,
          avatar_url: null,
          id: 1,
          email: null,
        }),
      };
    }) as unknown as typeof fetch;
    const flow = await beginOAuthDeviceFlow();
    let release!: () => void;
    const writeReady = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const rename = fs.rename.bind(fs);
    let blocked = false;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (!blocked && path.basename(String(args[1])) === "github.json") {
        blocked = true;
        markStarted();
        await writeReady;
      }
      return rename(...args);
    });

    now = 2_000;
    const polling = pollOAuthDeviceFlow(flow.flowId);
    await writeStarted;
    const cancelling = cancelOAuthDeviceFlow(flow.flowId);
    release();
    await expect(polling).resolves.toEqual({
      status: "expired",
      message: "This GitHub sign-in was cancelled.",
    });
    await cancelling;
    expect(await getToken()).toBe("ghp_previous");
  });

  it("does not persist OAuth credentials cancelled while the previous token is loading", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("ghp_previous");
    _resetTokenCache();
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_cancelled", scope: "repo,user:email" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: "octocat",
          name: null,
          avatar_url: null,
          id: 1,
          email: null,
        }),
      };
    }) as unknown as typeof fetch;
    const flow = await beginOAuthDeviceFlow();
    let release!: () => void;
    const readReady = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const readFile = fs.readFile.bind(fs);
    let blocked = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (!blocked && path.basename(String(args[0])) === "github.json") {
        blocked = true;
        markStarted();
        await readReady;
      }
      return readFile(...args);
    });

    now = 2_000;
    const polling = pollOAuthDeviceFlow(flow.flowId);
    await readStarted;
    const cancelling = cancelOAuthDeviceFlow(flow.flowId);
    release();
    await expect(polling).resolves.toMatchObject({ status: "expired" });
    await cancelling;
    expect(await getToken()).toBe("ghp_previous");
  });

  it("rolls back an OAuth credential commit expired by a concurrent poll", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("ghp_previous");
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_expired", scope: "repo,user:email" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: "octocat",
          name: null,
          avatar_url: null,
          id: 1,
          email: null,
        }),
      };
    }) as unknown as typeof fetch;
    const flow = await beginOAuthDeviceFlow();
    let release!: () => void;
    const writeReady = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const rename = fs.rename.bind(fs);
    let blocked = false;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (!blocked && path.basename(String(args[1])) === "github.json") {
        blocked = true;
        markStarted();
        await writeReady;
      }
      return rename(...args);
    });

    now = 2_000;
    const finishing = pollOAuthDeviceFlow(flow.flowId);
    await writeStarted;
    now += 30 * 60_000 + 1;
    const expiring = pollOAuthDeviceFlow(flow.flowId);
    release();
    await expect(expiring).resolves.toMatchObject({ status: "expired" });
    await expect(finishing).resolves.toMatchObject({ status: "expired" });
    expect(await getToken()).toBe("ghp_previous");
  });

  it("retries a timer-driven rollback after its first credential write fails", async () => {
    vi.useFakeTimers({ now: 1_000 });
    await setToken("ghp_previous");
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_expired", scope: "repo,user:email" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: "octocat",
          name: null,
          avatar_url: null,
          id: 1,
          email: null,
        }),
      };
    }) as unknown as typeof fetch;
    const flow = await beginOAuthDeviceFlow();
    await vi.advanceTimersByTimeAsync(1_000);
    let release!: () => void;
    const writeReady = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    let markRollbackFailed!: () => void;
    const rollbackFailed = new Promise<void>((resolve) => { markRollbackFailed = resolve; });
    const rename = fs.rename.bind(fs);
    let writes = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (path.basename(String(args[1])) === "github.json") {
        writes++;
        if (writes === 1) {
          markStarted();
          await writeReady;
        } else if (writes === 2) {
          markRollbackFailed();
          throw new Error("disk full");
        }
      }
      return rename(...args);
    });

    const finishing = pollOAuthDeviceFlow(flow.flowId);
    await writeStarted;
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
    release();
    await expect(finishing).resolves.toMatchObject({ status: "expired" });
    await rollbackFailed;
    await vi.waitFor(() => {
      expect(writes).toBe(3);
    }, { timeout: 5_000, interval: 100 });
    expect(await getToken()).toBe("ghp_previous");
  });

  it("retries a failed cancellation rollback when the flow is polled again", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("ghp_previous");
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_cancelled", scope: "repo,user:email" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: "octocat",
          name: null,
          avatar_url: null,
          id: 1,
          email: null,
        }),
      };
    }) as unknown as typeof fetch;
    const flow = await beginOAuthDeviceFlow();
    let release!: () => void;
    const writeReady = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const rename = fs.rename.bind(fs);
    let writes = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (path.basename(String(args[1])) === "github.json") {
        writes++;
        if (writes === 1) {
          markStarted();
          await writeReady;
        } else if (writes === 2) {
          throw new Error("disk full");
        }
      }
      return rename(...args);
    });

    now = 2_000;
    const finishing = pollOAuthDeviceFlow(flow.flowId);
    await writeStarted;
    const cancelling = cancelOAuthDeviceFlow(flow.flowId);
    release();
    await expect(finishing).resolves.toMatchObject({ status: "expired" });
    await expect(cancelling).rejects.toThrow("disk full");
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({ status: "expired" });
    expect(writes).toBe(3);
    expect(await getToken()).toBe("ghp_previous");
  });

  it("does not let an older flow overwrite a newer PAT", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1,
        }),
      };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    await setToken("ghp_newer");
    now = 2_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({ status: "expired" });
    expect(await getToken()).toBe("ghp_newer");
    expect(requests).toBe(1);
  });

  it("discards an issued token when credentials change during the exchange request", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let release!: () => void;
    const exchangeReady = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      markStarted();
      await exchangeReady;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "gho_stale", scope: "repo,user:email" }),
      };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    now = 2_000;
    const polling = pollOAuthDeviceFlow(flow.flowId);
    await exchangeStarted;
    await setToken("ghp_newer");
    release();
    await expect(polling).resolves.toMatchObject({ status: "expired" });
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toEqual({
      status: "expired",
      message: "This GitHub sign-in is no longer active. Start again.",
    });
    expect(await getToken()).toBe("ghp_newer");
  });

  it("retains an exchanged token while transient user validation is retried", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let tokenExchanges = 0;
    let userChecks = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        tokenExchanges++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_once", scope: "repo,user:email" }),
        };
      }
      userChecks++;
      if (userChecks === 1) {
        return { ok: false, status: 500, text: async () => "GitHub unavailable" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: "octocat",
          name: null,
          avatar_url: null,
          id: 1,
          email: null,
        }),
      };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    now = 2_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({
      status: "pending",
      message: expect.stringContaining("Retrying"),
    });
    // The device code may expire after exchange; the retained access token is
    // still valid and must remain usable for the validation retry.
    now = 902_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({ status: "complete" });
    expect(tokenExchanges).toBe(1);
    expect(userChecks).toBe(2);
    expect(await getToken()).toBe("gho_once");
  });

  it("retries a failed credential write without extending GitHub's token lifetimes", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "gho_retry",
            refresh_token: "ghr_retry",
            scope: "repo,user:email",
            expires_in: 600,
            refresh_token_expires_in: 1_200,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: "octocat",
          name: null,
          avatar_url: null,
          id: 1,
          email: null,
        }),
      };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    now = 2_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({
      status: "pending",
      message: expect.stringContaining("Retrying"),
    });

    now = 100_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({ status: "complete" });
    const stored = JSON.parse(await fs.readFile(path.join(TMP, "github.json"), "utf8"));
    expect(stored).toMatchObject({
      token: "gho_retry",
      expiresAt: 602_000,
      refreshTokenExpiresAt: 1_202_000,
    });
  });

  it("expires an exchanged token that cannot be validated within the retry window", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let userChecks = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_abandoned", scope: "repo,user:email" }),
        };
      }
      userChecks++;
      return { ok: false, status: 500, text: async () => "GitHub unavailable" };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    now = 2_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({ status: "pending" });
    now += 30 * 60_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({ status: "expired" });
    expect(userChecks).toBe(1);
    expect(await getToken()).toBeNull();
  });

  it("actively removes exchanged credentials when their finish deadline passes", async () => {
    vi.useFakeTimers({ now: 1_000 });
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_abandoned", scope: "repo,user:email" }),
        };
      }
      return { ok: false, status: 500, text: async () => "GitHub unavailable" };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({ status: "pending" });
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toEqual({
      status: "expired",
      message: "This GitHub sign-in is no longer active. Start again.",
    });
  });

  it("preserves the previous token when atomic replacement fails", async () => {
    await setToken("ghp_previous");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

    await expect(setToken("ghp_replacement")).rejects.toThrow("rename failed");
    _resetTokenCache();
    expect(await getToken()).toBe("ghp_previous");
    expect((await fs.readdir(TMP)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans orphaned credential temp files on startup and disconnect", async () => {
    await fs.mkdir(TMP, { recursive: true });
    const crashed = path.join(TMP, "github.json.99999999.crashed.tmp");
    const reusedPid = path.join(TMP, `github.json.${process.pid}.old-process.tmp`);
    await fs.writeFile(crashed, "secret");
    await fs.writeFile(reusedPid, "secret");
    const old = new Date(Date.now() - 11 * 60_000);
    await fs.utimes(reusedPid, old, old);
    expect(await getToken()).toBeNull();
    await expect(fs.stat(crashed)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(reusedPid)).rejects.toMatchObject({ code: "ENOENT" });

    await setToken("ghp_connected");
    const interrupted = path.join(TMP, `github.json.${process.pid}.interrupted.tmp`);
    await fs.writeFile(interrupted, "secret");
    await deleteToken();
    await expect(fs.stat(interrupted)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not return an expired OAuth token without a refresh token", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("gho_short", { authMethod: "oauth", expiresIn: 1 });
    now = 2_001;
    expect(await getToken()).toBeNull();
  });

  it("obeys slow_down and reports a denied authorization", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let polls = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      polls++;
      return {
        ok: true,
        status: 200,
        json: async () => polls === 1
          ? { error: "slow_down" }
          : polls === 2
            ? { error: "access_denied" }
            : { error: "expired_token" },
      };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    now = 2_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toEqual({
      status: "pending",
      retryAfterMs: 6_000,
    });
    now = 8_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toEqual({
      status: "denied",
      message: "GitHub authorization was cancelled.",
    });

    const expiredFlow = await beginOAuthDeviceFlow();
    now = 9_000;
    await expect(pollOAuthDeviceFlow(expiredFlow.flowId)).resolves.toEqual({
      status: "expired",
      message: "The GitHub sign-in code expired. Start again.",
    });
  });

  it("rejects an exchanged token when repo scope was not granted", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "gho_limited", scope: "user:email" }),
      };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    now = 2_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({
      status: "denied",
      message: expect.stringContaining("repo scope"),
    });
    expect(await getToken()).toBeNull();
  });

  it("refreshes an expiring Device Flow token without a client secret", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("gho_old", {
      authMethod: "oauth",
      refreshToken: "ghr_refresh",
      expiresIn: 30,
      refreshTokenExpiresIn: 3_600,
    });
    now = 32_000;
    let requestBody = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "gho_new",
          refresh_token: "ghr_rotated",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        }),
      };
    }) as unknown as typeof fetch;

    expect(await getToken()).toBe("gho_new");
    expect(requestBody).toContain("grant_type=refresh_token");
    expect(requestBody).toContain("refresh_token=ghr_refresh");
    expect(requestBody).not.toContain("client_secret");
  });

  it("retains a rotated token in memory until a failed persistence can be retried", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("gho_old", {
      authMethod: "oauth",
      refreshToken: "ghr_refresh",
      expiresIn: 30,
    });
    now = 32_000;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "gho_rotated",
        refresh_token: "ghr_rotated",
        expires_in: 28_800,
      }),
    })) as unknown as typeof fetch;
    const rename = fs.rename.bind(fs);
    let renames = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      renames++;
      if (renames === 2) throw new Error("disk full");
      return rename(...args);
    });

    expect(await getToken()).toBe("gho_rotated");
    _resetTokenCache();
    expect(await getToken()).toBe("gho_rotated");
  });

  it("recovers a complete refresh journal temp left before its rename", async () => {
    await setToken("gho_old", {
      authMethod: "oauth",
      refreshToken: "ghr_old",
      expiresIn: 3_600,
    });
    const recovery = path.join(TMP, "github-refresh.json.99999999.crashed.tmp");
    await fs.writeFile(recovery, JSON.stringify({
      previousToken: "gho_old",
      config: {
        token: "gho_recovered",
        authMethod: "oauth",
        refreshToken: "ghr_recovered",
        expiresAt: Date.now() + 7_200_000,
      },
    }));

    _resetTokenCache();
    expect(await getToken()).toBe("gho_recovered");
    _resetTokenCache();
    expect(await getToken()).toBe("gho_recovered");
  });

  it("does not restore a refresh journal after github.json was manually deleted", async () => {
    await setToken("gho_old", {
      authMethod: "oauth",
      refreshToken: "ghr_old",
      expiresIn: 3_600,
    });
    await fs.writeFile(path.join(TMP, "github-refresh.json"), JSON.stringify({
      previousToken: "gho_old",
      config: {
        token: "gho_recovered",
        authMethod: "oauth",
        refreshToken: "ghr_recovered",
        expiresAt: Date.now() + 7_200_000,
      },
    }));
    await fs.rm(path.join(TMP, "github.json"));

    _resetTokenCache();
    expect(await getToken()).toBeNull();
    await expect(fs.stat(path.join(TMP, "github-refresh.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not invalidate a pending Device Flow during maintenance refresh", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("gho_old", {
      authMethod: "oauth",
      refreshToken: "ghr_refresh",
      expiresIn: 30,
    });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/login/device/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
        };
      }
      if (String(url).endsWith("/login/oauth/access_token")) {
        const body = new URLSearchParams(String(init?.body));
        return {
          ok: true,
          status: 200,
          json: async () => body.get("grant_type") === "refresh_token"
            ? {
                access_token: "gho_rotated",
                refresh_token: "ghr_rotated",
                expires_in: 28_800,
              }
            : { access_token: "gho_reconnected", scope: "repo,user:email" },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: "octocat",
          name: null,
          avatar_url: null,
          id: 1,
          email: null,
        }),
      };
    }) as unknown as typeof fetch;

    const flow = await beginOAuthDeviceFlow();
    now = 32_000;
    expect(await getToken()).toBe("gho_rotated");
    now = 33_000;
    await expect(pollOAuthDeviceFlow(flow.flowId)).resolves.toMatchObject({ status: "complete" });
    expect(await getToken()).toBe("gho_reconnected");
  });

  it("serializes replacement credentials after an in-flight refresh", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("gho_old", {
      authMethod: "oauth",
      refreshToken: "ghr_refresh",
      expiresIn: 30,
    });
    now = 32_000;
    let release!: () => void;
    const responseReady = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    globalThis.fetch = (async () => {
      markStarted();
      await responseReady;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "gho_stale", expires_in: 28_800 }),
      };
    }) as unknown as typeof fetch;

    const refreshing = getToken();
    await refreshStarted;
    await setToken("ghp_replacement");
    release();
    expect(await refreshing).toBe("ghp_replacement");
    expect(await getToken()).toBe("ghp_replacement");
  });

  it("keeps a rotated OAuth token when the queued replacement fails", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await setToken("gho_old", {
      authMethod: "oauth",
      refreshToken: "ghr_refresh",
      expiresIn: 30,
    });
    now = 32_000;
    let release!: () => void;
    const responseReady = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    globalThis.fetch = (async () => {
      markStarted();
      await responseReady;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "gho_rotated",
          refresh_token: "ghr_rotated",
          expires_in: 28_800,
        }),
      };
    }) as unknown as typeof fetch;
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("replacement failed"));

    const refreshing = getToken();
    await refreshStarted;
    await expect(setToken("ghp_failed")).rejects.toThrow("replacement failed");
    release();
    expect(await refreshing).toBe("gho_rotated");
    _resetTokenCache();
    expect(await getToken()).toBe("gho_rotated");
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
