import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

const TMP = path.join(os.tmpdir(), `gitwebui-identity-${randomBytes(6).toString("hex")}`);
process.env.GITWEBUI_CONFIG_DIR = TMP;

const { getIdentity, setIdentity, clearIdentity, _resetIdentityCache } = await import("./identity.js");

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  _resetIdentityCache();
});
afterAll(() => fs.rm(TMP, { recursive: true, force: true }));

describe("commit identity storage", () => {
  it("has none by default", async () => {
    expect(await getIdentity()).toBeNull();
  });

  it("stores, reads (across a cache reset), and clears", async () => {
    await setIdentity("Ada Lovelace", "ada@example.com");
    expect(await getIdentity()).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    _resetIdentityCache();
    expect(await getIdentity()).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    await clearIdentity();
    expect(await getIdentity()).toBeNull();
  });

  it("trims and validates", async () => {
    await setIdentity("  Ada  ", "  ada@example.com  ");
    expect(await getIdentity()).toEqual({ name: "Ada", email: "ada@example.com" });
    await expect(setIdentity("", "ada@example.com")).rejects.toMatchObject({ status: 400 });
    await expect(setIdentity("Ada", "not-an-email")).rejects.toMatchObject({ status: 400 });
  });
});
