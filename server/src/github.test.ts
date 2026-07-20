import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

const TMP = path.join(os.tmpdir(), `gitwebui-gh-test-${randomBytes(6).toString("hex")}`);
process.env.GITWEBUI_CONFIG_DIR = TMP;

const { getToken, setToken, deleteToken, hasToken, _resetTokenCache } = await import("./github.js");

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
