import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import http, { type Server } from "node:http";

// A throwaway config dir, chosen before the modules load. Nothing should be
// written to it — a desktop-mode server has no password to store — and the
// tests below check exactly that.
const TMP = path.join(os.tmpdir(), `gitwebui-desktop-test-${randomBytes(6).toString("hex")}`);
process.env.GITWEBUI_CONFIG_DIR = TMP;

const { createApp } = await import("./app.js");
const { LOOPBACK_HOSTS } = await import("./originGuard.js");

const TOKEN = randomBytes(24).toString("base64url");
let base = "";
let server: Server;

/** The whole app over a real socket, wired the way the desktop app wires it. */
beforeAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  server = createApp({ desktopToken: TOKEN, allowedHosts: LOOPBACK_HOSTS }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(TMP, { recursive: true, force: true });
});

const cookie = (value: string) => ({ Cookie: `gwui_desktop=${value}` });

function get(p: string, headers: Record<string, string> = {}) {
  return fetch(base + p, { headers });
}

function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** A protected route: 401 unauthenticated, 409 when admitted with no repo open. */
async function protectedStatus(headers: Record<string, string> = {}): Promise<number> {
  return (await get("/api/terminal/shells", headers)).status;
}

/**
 * A GET over a raw socket, because `Host` is a forbidden header name for
 * `fetch` — undici overwrites it with the address it dialled, which is the
 * opposite of what a rebinding test needs to send.
 */
function rawGet(p: string, headers: Record<string, string>): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: p, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the window the app opened", () => {
  it("is let in by the token it was handed", async () => {
    expect(await protectedStatus(cookie(TOKEN))).toBe(409); // past auth, no repo named
  });

  it("is told the gate is settled, so no login screen is drawn", async () => {
    // The store reads exactly these two fields: configured && authenticated is
    // what makes it skip AuthGate entirely.
    const res = await get("/api/auth/status", cookie(TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, authenticated: true });
  });
});

describe("anything else that finds the port", () => {
  it("is refused without the token", async () => {
    expect(await protectedStatus()).toBe(401);
  });

  it("is refused with the wrong token", async () => {
    expect(await protectedStatus(cookie("not-the-token"))).toBe(401);
  });

  it("is refused with a wrong token of exactly the right length", async () => {
    // Same length is the case a length check would wave through, and the case
    // the constant-time compare exists for.
    const nearMiss = "x".repeat(TOKEN.length);
    expect(nearMiss.length).toBe(TOKEN.length);
    expect(await protectedStatus(cookie(nearMiss))).toBe(401);
  });

  it("is told the install is configured, so it is offered no setup screen", async () => {
    const res = await get("/api/auth/status");
    expect(await res.json()).toEqual({ configured: true, authenticated: false });
  });

  it("cannot claim the install by setting a password", async () => {
    // This is why desktop mode replaces the gate rather than bypassing it: the
    // desktop user never set a password, so an open setup route would let any
    // local process take ownership of the app.
    const res = await post("/api/auth/setup", { password: "hunter2 hunter2" });
    expect(res.status).toBe(403);
    await expect(fs.readFile(path.join(TMP, "auth.json"), "utf8")).rejects.toThrow();
  });

  it("cannot sign in", async () => {
    expect((await post("/api/auth/login", { password: "hunter2 hunter2" })).status).toBe(403);
  });

  it("still cannot get in after being refused", async () => {
    expect(await protectedStatus()).toBe(401);
  });
});

describe("the loopback port is not private", () => {
  it("refuses a request addressed to a rebound name", async () => {
    // DNS rebinding hands an attacker's page a genuine same-origin position, so
    // the Origin check cannot help. The Host header is what still gives it away.
    expect(await rawGet("/api/auth/status", { ...cookie(TOKEN), Host: "evil.example" })).toBe(403);
  });

  it("still answers the loopback name it was given", async () => {
    // The counterpart to the check above: the guard must not be rejecting
    // everything, which would pass the test above for the wrong reason.
    expect(await rawGet("/api/auth/status", { ...cookie(TOKEN), Host: "localhost" })).toBe(200);
  });

  it("refuses a cross-origin request even holding the token", async () => {
    const res = await post(
      "/api/auth/logout",
      {},
      { ...cookie(TOKEN), Origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });
});

describe("signing out", () => {
  it("reports success but doesn't hand back a session the app still needs", async () => {
    const res = await post("/api/auth/logout", {}, cookie(TOKEN));
    expect(res.status).toBe(200);
    expect(await protectedStatus(cookie(TOKEN))).toBe(409);
  });
});
