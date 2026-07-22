import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

// Point the config dir at a throwaway location BEFORE importing the modules
// (config.ts resolves CONFIG_DIR at import time).
const TMP = path.join(os.tmpdir(), `gitwebui-authroutes-test-${randomBytes(6).toString("hex")}`);
process.env.GITWEBUI_CONFIG_DIR = TMP;

const { createApp } = await import("./app.js");
const { _resetAuthCache, _resetLoginThrottle } = await import("./auth.js");

const PASSWORD = "correct horse";
let base = "";
let server: Server;

/** The whole app over a real socket, so the tests exercise the middleware chain. */
beforeAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  _resetAuthCache();
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const res = await post("/api/auth/setup", { password: PASSWORD });
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(TMP, { recursive: true, force: true });
});

beforeEach(() => _resetLoginThrottle());

function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Sign in and return the session cookie the browser would hold. */
async function signIn(remember = true): Promise<string> {
  const res = await post("/api/auth/login", { password: PASSWORD, remember });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** A protected route: 401 unauthenticated, 409 when authenticated with no repo open. */
async function protectedStatus(cookie?: string): Promise<number> {
  const res = await fetch(base + "/api/terminal/shells", {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return res.status;
}

describe("the API is closed without a session", () => {
  it("rejects a protected route and admits one with a session", async () => {
    expect(await protectedStatus()).toBe(401);
    expect(await protectedStatus(await signIn())).toBe(409); // past auth, no repo named
  });

  it("answers no cross-origin request readably", async () => {
    // Without an Allow-Origin header a browser refuses to hand the response to
    // the calling page, which is what keeps the login route from being an oracle.
    const res = await post("/api/auth/login", { password: "wrong" }, { Origin: "https://evil.example" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("signing out", () => {
  it("retires the token that was used, and only that one", async () => {
    const laptop = await signIn();
    const phone = await signIn();
    expect(await protectedStatus(laptop)).toBe(409);

    const out = await post("/api/auth/logout", {}, { Cookie: laptop });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");

    expect(await protectedStatus(laptop)).toBe(401);
    expect(await protectedStatus(phone)).toBe(409);
  });

  it("succeeds without saying whether the cookie meant anything", async () => {
    expect((await post("/api/auth/logout", {})).status).toBe(200);
    expect((await post("/api/auth/logout", {}, { Cookie: "gwui_session=junk" })).status).toBe(200);
  });
});

describe("login throttle", () => {
  it("stops accepting guesses after enough failures, and says how long for", async () => {
    let sawBlock: Response | null = null;
    for (let i = 0; i < 12 && !sawBlock; i++) {
      const res = await post("/api/auth/login", { password: `wrong-${i}` });
      if (res.status === 429) sawBlock = res;
      else expect(res.status).toBe(401);
    }
    expect(sawBlock).not.toBeNull();
    expect(Number(sawBlock!.headers.get("retry-after"))).toBeGreaterThan(0);
    // The lockout is what makes it a lockout: the right password waits too.
    expect((await post("/api/auth/login", { password: PASSWORD })).status).toBe(429);
  });

  it("counts a burst sent all at once, so concurrency can't slip past it", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => post("/api/auth/login", { password: `burst-${i}` })),
    );
    const blocked = results.filter((r) => r.status === 429).length;
    const hashed = results.filter((r) => r.status === 401).length;
    expect(blocked).toBeGreaterThan(0);
    expect(hashed).toBeLessThan(results.length);
    expect(hashed + blocked).toBe(results.length);
  });

  it("forgets the failures once the right password arrives", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post("/api/auth/login", { password: "nope" })).status).toBe(401);
    }
    expect((await post("/api/auth/login", { password: PASSWORD })).status).toBe(200);
    // Counter cleared — a fresh run of failures gets the full allowance again.
    for (let i = 0; i < 6; i++) {
      expect((await post("/api/auth/login", { password: "nope" })).status).toBe(401);
    }
  });

  it("keeps serving the rest of the app while guesses are being hashed", async () => {
    const flood = Array.from({ length: 20 }, (_, i) => post("/api/auth/login", { password: `flood-${i}` }));
    const started = Date.now();
    const status = await fetch(base + "/api/auth/status");
    const waited = Date.now() - started;
    await Promise.all(flood);
    expect(status.status).toBe(200);
    // Hashing on the threadpool instead of inline keeps this off the event loop;
    // with the synchronous hash this took ~1.1s.
    expect(waited).toBeLessThan(400);
  });
});
