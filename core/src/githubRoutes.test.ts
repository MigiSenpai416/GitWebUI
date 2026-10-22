import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

const TMP = path.join(os.tmpdir(), `gitwebui-githubroutes-${randomBytes(6).toString("hex")}`);
process.env.GITWEBUI_CONFIG_DIR = TMP;

const { dispatch, errorMessage, errorStatus } = await import("./api.js");
const { _resetTokenCache } = await import("./github.js");
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  _resetTokenCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** Make one call the way the main process does, JSON round-trip included. */
async function call(route: string, input: Record<string, unknown> = {}) {
  try {
    const result = await dispatch(route, input, { root: "", signal: new AbortController().signal });
    return { status: 200, body: JSON.parse(JSON.stringify(result)) };
  } catch (e) {
    return { status: errorStatus(e), body: { error: errorMessage(e) } };
  }
}

describe("GitHub OAuth routes", () => {
  it("returns the disconnected status shape and validates poll input", async () => {
    const status = await call("githubStatus");
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      configured: false,
      authMethod: null,
      user: null,
    });

    const poll = await call("githubOAuthPoll");
    expect(poll.status).toBe(400);
    expect(poll.body).toEqual({ error: "An OAuth flow is required" });
  });

  it("starts, cancels, and serializes a Device Flow without exposing its secret", async () => {
    globalThis.fetch = (async (url: string) => {
      if (!String(url).startsWith("https://github.com/")) return realFetch(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "server-only-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      };
    }) as unknown as typeof fetch;

    const started = await call("githubOAuthStart");
    expect(started.status).toBe(200);
    const flow = started.body as { flowId: string; userCode: string; deviceCode?: string };
    expect(flow.userCode).toBe("ABCD-EFGH");
    expect(flow.deviceCode).toBeUndefined();

    const cancelled = await call("githubOAuthCancel", { flowId: flow.flowId });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ ok: true });

    const polled = await call("githubOAuthPoll", { flowId: flow.flowId });
    expect(polled.status).toBe(200);
    expect(polled.body).toMatchObject({ status: "expired" });
  });

  it("completes OAuth and preserves the PAT response contracts", async () => {
    let tokenExchanges = 0;
    globalThis.fetch = (async (url: string) => {
      const value = String(url);
      if (value.endsWith("/login/device/code")) {
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
      if (value.endsWith("/login/oauth/access_token")) {
        tokenExchanges++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_route", scope: "repo,user:email" }),
        };
      }
      if (value === "https://api.github.com/user") {
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
      }
      return realFetch(url);
    }) as unknown as typeof fetch;

    const started = await call("githubOAuthStart");
    const flow = started.body as { flowId: string };
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const polled = await call("githubOAuthPoll", { flowId: flow.flowId });
    expect(polled.status).toBe(200);
    expect(polled.body).toMatchObject({
      status: "complete",
      user: { login: "octocat" },
    });
    expect(tokenExchanges).toBe(1);

    const oauthStatus = await call("githubStatus");
    expect(oauthStatus.body).toMatchObject({
      configured: true,
      authMethod: "oauth",
      user: { login: "octocat" },
    });

    const pat = await call("githubSetToken", { token: "ghp_route" });
    expect(pat.status).toBe(200);
    expect(pat.body).toMatchObject({
      configured: true,
      authMethod: "pat",
      user: { login: "octocat" },
    });

    const disconnected = await call("githubRevoke");
    expect(disconnected.status).toBe(200);
    expect(disconnected.body).toEqual({
      configured: false,
      authMethod: null,
      user: null,
    });
  });
});
