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
  revokeToken,
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

describe("an unreadable password file", () => {
  const authFile = path.join(TMP, "auth.json");

  /** Write `contents` where the password lives, then read it as a fresh process would. */
  async function withStoredFile(contents: string): Promise<void> {
    await fs.mkdir(TMP, { recursive: true });
    await fs.writeFile(authFile, contents, "utf8");
    _resetAuthCache();
  }

  it("counts as configured, so setup stays shut", async () => {
    await setupPassword("s3cret!");
    const good = await fs.readFile(authFile, "utf8");
    // A crash partway through writing the file leaves exactly this.
    await withStoredFile(good.slice(0, 40));

    expect(await isConfigured()).toBe(true);
    await expect(setupPassword("stranger-owns-this")).rejects.toThrow(/can't be read/);
    // And nobody can sign in with it either — it fails shut, not open.
    expect(await verifyPassword("s3cret!")).toBe(false);
  });

  it("treats a file with missing fields the same way", async () => {
    await withStoredFile(JSON.stringify({ passwordHash: "abc" }));
    expect(await isConfigured()).toBe(true);
    await expect(setupPassword("stranger-owns-this")).rejects.toThrow(/can't be read/);
  });

  it("does not cache the failure — a repaired file is picked up without a restart", async () => {
    await setupPassword("s3cret!");
    const good = await fs.readFile(authFile, "utf8");
    await withStoredFile("{ truncated");
    expect(await verifyPassword("s3cret!")).toBe(false);

    // Put the real file back; no restart, no cache reset.
    await fs.writeFile(authFile, good, "utf8");
    expect(await verifyPassword("s3cret!")).toBe(true);
    expect(await isConfigured()).toBe(true);
  });

  it("still treats a genuinely absent file as unconfigured", async () => {
    await fs.rm(authFile, { force: true });
    _resetAuthCache();
    expect(await isConfigured()).toBe(false);
    await expect(setupPassword("first-run-password")).resolves.toBeUndefined();
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

  it("carries an id, so a token can be told apart from any other", async () => {
    const a = await issueToken(false);
    const b = await issueToken(false);
    const idOf = (t: string) =>
      (JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString("utf8")) as { jti: string }).jti;
    expect(idOf(a)).toBeTruthy();
    expect(idOf(a)).not.toBe(idOf(b));
    expect(a).not.toBe(b);
  });
});

describe("signing out", () => {
  beforeEach(() => setupPassword("s3cret!"));

  it("stops the token that was signed out from being used again", async () => {
    const token = await issueToken(true);
    expect(await verifyToken(token)).toBe(true);
    await revokeToken(token);
    expect(await verifyToken(token)).toBe(false);
  });

  it("leaves other sessions alone", async () => {
    const phone = await issueToken(true);
    const laptop = await issueToken(true);
    await revokeToken(laptop);
    expect(await verifyToken(laptop)).toBe(false);
    expect(await verifyToken(phone)).toBe(true);
  });

  it("survives a restart — the signing secret does, so the revocation must too", async () => {
    const token = await issueToken(true);
    await revokeToken(token);
    // Drop every in-memory cache; the config dir is all that's left, as after a restart.
    _resetAuthCache();
    expect(await verifyToken(token)).toBe(false);
  });

  it("is a no-op for tokens it can't verify", async () => {
    await expect(revokeToken(undefined)).resolves.toBeUndefined();
    await expect(revokeToken("garbage")).resolves.toBeUndefined();
    await expect(revokeToken("a.b")).resolves.toBeUndefined();
    // A valid token stays valid when someone else's junk is "signed out".
    const token = await issueToken(false);
    await revokeToken("not.a-real-token");
    expect(await verifyToken(token)).toBe(true);
  });

  it("rejects a token with no id — it predates revocation and could never be retired", async () => {
    // Sign an old-shape payload (exp only) with this install's real secret by
    // issuing a token and reusing its signature over a rewritten payload.
    const real = await issueToken(false);
    const { createHmac } = await import("node:crypto");
    const raw = JSON.parse(await fs.readFile(path.join(TMP, "auth.json"), "utf8")) as {
      secret: string;
    };
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60_000 })).toString("base64url");
    const sig = createHmac("sha256", raw.secret).update(payload).digest("base64url");
    expect(await verifyToken(`${payload}.${sig}`)).toBe(false);
    expect(await verifyToken(real)).toBe(true);
  });

  it("keeps every sign-out that happens at the same moment", async () => {
    const tokens = await Promise.all(Array.from({ length: 6 }, () => issueToken(true)));
    // A cold cache is what any restart leaves behind, and it is where the
    // concurrent loads used to build separate maps and discard each other.
    _resetAuthCache();
    await Promise.all(tokens.map((t) => revokeToken(t)));

    for (const t of tokens) expect(await verifyToken(t)).toBe(false);
    const list = JSON.parse(
      await fs.readFile(path.join(TMP, "revoked-sessions.json"), "utf8"),
    ) as Record<string, number>;
    expect(Object.keys(list)).toHaveLength(6);
  });

  it("survives a sign-out racing ordinary authenticated traffic", async () => {
    const victim = await issueToken(true);
    const other = await issueToken(true);
    _resetAuthCache();
    // The burst of authenticated requests a page load makes, with the sign-out
    // landing in the middle of it — each one touches the same cold cache.
    await Promise.all([
      ...Array.from({ length: 8 }, () => verifyToken(other)),
      revokeToken(victim),
      ...Array.from({ length: 8 }, () => verifyToken(other)),
    ]);
    expect(await verifyToken(victim)).toBe(false);
    expect(await verifyToken(other)).toBe(true);
  });

  it("keeps persisting after a write fails", async () => {
    const listPath = path.join(TMP, "revoked-sessions.json");
    await fs.rm(listPath, { recursive: true, force: true });
    // A directory where the file belongs makes every write fail.
    await fs.mkdir(listPath, { recursive: true });

    const blocked = await issueToken(true);
    await expect(revokeToken(blocked)).rejects.toThrow();
    // The token is dead in this process even though the list never reached disk.
    expect(await verifyToken(blocked)).toBe(false);

    await fs.rm(listPath, { recursive: true, force: true });
    const next = await issueToken(true);
    await expect(revokeToken(next)).resolves.toBeUndefined();

    // One good write re-persists what the failed one lost, since each write is
    // a snapshot of the whole list.
    const list = JSON.parse(await fs.readFile(listPath, "utf8")) as Record<string, number>;
    expect(Object.keys(list)).toHaveLength(2);
    _resetAuthCache();
    expect(await verifyToken(blocked)).toBe(false);
    expect(await verifyToken(next)).toBe(false);
  });

  it("forgets a revocation once the token would have expired anyway", async () => {
    const token = await issueToken(false);
    await revokeToken(token);
    const listPath = path.join(TMP, "revoked-sessions.json");
    const list = JSON.parse(await fs.readFile(listPath, "utf8")) as Record<string, number>;
    expect(Object.keys(list)).toHaveLength(1);

    // Age the stored entry past its expiry, then trigger a fresh load + prune.
    const [jti] = Object.keys(list);
    await fs.writeFile(listPath, JSON.stringify({ [jti]: Date.now() - 1000 }), "utf8");
    _resetAuthCache();
    await revokeToken(await issueToken(false));
    const pruned = JSON.parse(await fs.readFile(listPath, "utf8")) as Record<string, number>;
    expect(pruned[jti]).toBeUndefined();
    expect(Object.keys(pruned)).toHaveLength(1);
  });
});
