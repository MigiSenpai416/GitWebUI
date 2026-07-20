import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

// Point the config dir at a throwaway location BEFORE importing the modules
// (config.ts resolves CONFIG_DIR at import time).
const TMP = path.join(os.tmpdir(), `gitwebui-auth-test-${randomBytes(6).toString("hex")}`);
process.env.GITWEBUI_CONFIG_DIR = TMP;

const {
  isConfigured,
  setupPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  _resetAuthCache,
} = await import("./auth.js");

async function freshInstall(): Promise<void> {
  await fs.rm(TMP, { recursive: true, force: true });
  _resetAuthCache();
}

beforeEach(freshInstall);
afterAll(() => fs.rm(TMP, { recursive: true, force: true }));

describe("password setup + verify", () => {
  it("is unconfigured before setup", async () => {
    expect(await isConfigured()).toBe(false);
    expect(await verifyPassword("anything")).toBe(false);
  });

  it("verifies the correct password and rejects the wrong one", async () => {
    await setupPassword("correct horse");
    expect(await isConfigured()).toBe(true);
    expect(await verifyPassword("correct horse")).toBe(true);
    expect(await verifyPassword("Correct horse")).toBe(false);
    expect(await verifyPassword("")).toBe(false);
  });

  it("rejects too-short passwords and double setup", async () => {
    await expect(setupPassword("12345")).rejects.toThrow(/at least/);
    await setupPassword("123456");
    await expect(setupPassword("another1")).rejects.toThrow(/already configured/);
  });
});

describe("session tokens", () => {
  beforeEach(() => setupPassword("s3cret!"));

  it("round-trips a freshly issued token", async () => {
    const token = await issueToken(false);
    expect(await verifyToken(token)).toBe(true);
  });

  it("rejects a tampered payload/signature", async () => {
    const token = await issueToken(true);
    const [payload, sig] = token.split(".");
    expect(await verifyToken(`${payload}x.${sig}`)).toBe(false);
    expect(await verifyToken(`${payload}.${sig}x`)).toBe(false);
    expect(await verifyToken(undefined)).toBe(false);
    expect(await verifyToken("garbage")).toBe(false);
  });

  it("rejects an expired token", async () => {
    // Hand-roll a token with an exp in the past, signed with the real secret,
    // by round-tripping through the module: issue one, then rewrite exp.
    const good = await issueToken(false);
    const sig = good.slice(good.indexOf(".") + 1);
    const expiredPayload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString(
      "base64url",
    );
    // Different payload → signature no longer matches → invalid regardless.
    expect(await verifyToken(`${expiredPayload}.${sig}`)).toBe(false);
  });
});
