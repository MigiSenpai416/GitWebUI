import { describe, it, expect, afterEach, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { configDir, configPath, setConfigDir, getRecent, addRecent } from "./config.js";

const ORIGINAL_ENV = process.env.GITWEBUI_CONFIG_DIR;

beforeEach(() => {
  setConfigDir(null);
  delete process.env.GITWEBUI_CONFIG_DIR;
});

afterEach(() => {
  setConfigDir(null);
  if (ORIGINAL_ENV === undefined) delete process.env.GITWEBUI_CONFIG_DIR;
  else process.env.GITWEBUI_CONFIG_DIR = ORIGINAL_ENV;
});

function tmp(): string {
  return path.join(os.tmpdir(), `gitwebui-config-test-${randomBytes(6).toString("hex")}`);
}

describe("where the config lives", () => {
  it("falls back to a per-OS location when nothing says otherwise", () => {
    const dir = configDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.basename(dir)).toBe("gitwebui");
  });

  it("takes the environment over the default", () => {
    const dir = tmp();
    process.env.GITWEBUI_CONFIG_DIR = dir;
    expect(configDir()).toBe(dir);
  });

  it("takes an explicit choice over the environment", () => {
    // An embedder that has decided where state belongs shouldn't have that
    // quietly undone by a variable left in the environment.
    const fromEnv = tmp();
    const chosen = tmp();
    process.env.GITWEBUI_CONFIG_DIR = fromEnv;
    setConfigDir(chosen);
    expect(configDir()).toBe(chosen);
  });

  it("goes back to the environment when the choice is withdrawn", () => {
    const fromEnv = tmp();
    process.env.GITWEBUI_CONFIG_DIR = fromEnv;
    setConfigDir(tmp());
    setConfigDir(null);
    expect(configDir()).toBe(fromEnv);
  });

  it("is read per call, not captured at import", () => {
    // This is the whole point of the indirection: the desktop entry point picks
    // the directory during startup, long after these modules were loaded.
    const first = tmp();
    const second = tmp();
    setConfigDir(first);
    expect(configPath("auth.json")).toBe(path.join(first, "auth.json"));
    setConfigDir(second);
    expect(configPath("auth.json")).toBe(path.join(second, "auth.json"));
  });
});

describe("recent repositories", () => {
  it("reads back what it wrote, most recent first", async () => {
    const dir = tmp();
    setConfigDir(dir);
    try {
      expect(await getRecent()).toEqual([]);
      await addRecent("/one");
      await addRecent("/two");
      expect(await getRecent()).toEqual(["/two", "/one"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("moves a repeat visit to the front instead of duplicating it", async () => {
    const dir = tmp();
    setConfigDir(dir);
    try {
      await addRecent("/one");
      await addRecent("/two");
      await addRecent("/one");
      expect(await getRecent()).toEqual(["/one", "/two"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("writes into whichever directory is current at the time", async () => {
    const a = tmp();
    const b = tmp();
    try {
      setConfigDir(a);
      await addRecent("/in-a");
      setConfigDir(b);
      expect(await getRecent()).toEqual([]);
      await addRecent("/in-b");
      setConfigDir(a);
      expect(await getRecent()).toEqual(["/in-a"]);
    } finally {
      await fs.rm(a, { recursive: true, force: true });
      await fs.rm(b, { recursive: true, force: true });
    }
  });
});
