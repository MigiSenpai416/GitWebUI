import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

const TMP = path.join(os.tmpdir(), `gitwebui-githubroutes-${randomBytes(6).toString("hex")}`);
process.env.GITWEBUI_CONFIG_DIR = TMP;

const { api, apiErrorHandler } = await import("./routes.js");
const { _resetTokenCache } = await import("./github.js");
const realFetch = globalThis.fetch;
let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", api);
  app.use("/api", apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  _resetTokenCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(TMP, { recursive: true, force: true });
});

function request(pathname: string, method = "GET", body?: unknown) {
  return realFetch(base + pathname, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("GitHub OAuth routes", () => {
  it("returns the disconnected status shape and validates poll input", async () => {
    const status = await request("/api/github/status");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      configured: false,
      authMethod: null,
      user: null,
    });

    const poll = await request("/api/github/oauth/poll", "POST", {});
    expect(poll.status).toBe(400);
    await expect(poll.json()).resolves.toEqual({ error: "An OAuth flow is required" });
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

    const started = await request("/api/github/oauth/device", "POST", {});
    expect(started.status).toBe(200);
    const flow = await started.json() as { flowId: string; userCode: string; deviceCode?: string };
    expect(flow.userCode).toBe("ABCD-EFGH");
    expect(flow.deviceCode).toBeUndefined();

    const cancelled = await request("/api/github/oauth/device", "DELETE", { flowId: flow.flowId });
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toEqual({ ok: true });

    const polled = await request("/api/github/oauth/poll", "POST", { flowId: flow.flowId });
    expect(polled.status).toBe(200);
    await expect(polled.json()).resolves.toMatchObject({ status: "expired" });
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

    const started = await request("/api/github/oauth/device", "POST", {});
    const flow = await started.json() as { flowId: string };
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const polled = await request("/api/github/oauth/poll", "POST", { flowId: flow.flowId });
    expect(polled.status).toBe(200);
    await expect(polled.json()).resolves.toMatchObject({
      status: "complete",
      user: { login: "octocat" },
    });
    expect(tokenExchanges).toBe(1);

    const oauthStatus = await request("/api/github/status");
    await expect(oauthStatus.json()).resolves.toMatchObject({
      configured: true,
      authMethod: "oauth",
      user: { login: "octocat" },
    });

    const pat = await request("/api/github/token", "POST", { token: "ghp_route" });
    expect(pat.status).toBe(200);
    await expect(pat.json()).resolves.toMatchObject({
      configured: true,
      authMethod: "pat",
      user: { login: "octocat" },
    });

    const disconnected = await request("/api/github/token", "DELETE", {});
    expect(disconnected.status).toBe(200);
    await expect(disconnected.json()).resolves.toEqual({
      configured: false,
      authMethod: null,
      user: null,
    });
  });
});
