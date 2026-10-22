import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { setConfigDir } from "../config.js";
import {
  gitPath,
  setGitPath,
  hasGitPathOverride,
  isUsableGit,
  resolveGitPath,
  loadGitPathOverride,
  saveGitPathOverride,
  _resetGitPath,
} from "./gitPath.js";

const ORIGINAL_ENV = process.env.GITWEBUI_GIT_PATH;
let dir = "";

beforeEach(() => {
  _resetGitPath();
  delete process.env.GITWEBUI_GIT_PATH;
  dir = path.join(os.tmpdir(), `gitwebui-gitpath-test-${randomBytes(6).toString("hex")}`);
  setConfigDir(dir);
});

afterEach(async () => {
  _resetGitPath();
  setConfigDir(null);
  if (ORIGINAL_ENV === undefined) delete process.env.GITWEBUI_GIT_PATH;
  else process.env.GITWEBUI_GIT_PATH = ORIGINAL_ENV;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("which git gets run", () => {
  it("is a bare `git` until something says otherwise", () => {
    // The headless server inherits a usable PATH from the shell that started
    // it, so resolving anything would be work with no answer to show for it.
    expect(gitPath()).toBe("git");
    expect(hasGitPathOverride()).toBe(false);
  });

  it("uses a pinned path", () => {
    setGitPath("/opt/homebrew/bin/git");
    expect(gitPath()).toBe("/opt/homebrew/bin/git");
    expect(hasGitPathOverride()).toBe(true);
  });

  it("reads the environment when nothing is pinned", () => {
    process.env.GITWEBUI_GIT_PATH = "/custom/git";
    expect(gitPath()).toBe("/custom/git");
  });

  it("lets a pinned path win over the environment", () => {
    process.env.GITWEBUI_GIT_PATH = "/custom/git";
    setGitPath("/picked/git");
    expect(gitPath()).toBe("/picked/git");
  });

  it("goes back to PATH when the pin is removed", () => {
    setGitPath("/picked/git");
    setGitPath(null);
    expect(gitPath()).toBe("git");
  });
});

describe("recognising a real git", () => {
  it("accepts the git this machine runs the rest of the suite with", async () => {
    expect(await isUsableGit("git")).toBe(true);
  });

  it("rejects a name that isn't there", async () => {
    expect(await isUsableGit("gitwebui-no-such-binary")).toBe(false);
  });

  it("rejects a program that runs but isn't git", async () => {
    // Confirmed by what it prints, not by its exit code — otherwise any
    // successful command would pass for git.
    const notGit = process.platform === "win32" ? "cmd.exe" : "/bin/echo";
    expect(await isUsableGit(notGit)).toBe(false);
  });
});

describe("remembering the user's choice", () => {
  it("has nothing to report before anything is saved", async () => {
    expect(await loadGitPathOverride()).toBeNull();
  });

  it("reads back what was saved", async () => {
    await saveGitPathOverride("/somewhere/git");
    expect(await loadGitPathOverride()).toBe("/somewhere/git");
  });

  it("forgets it when asked", async () => {
    await saveGitPathOverride("/somewhere/git");
    await saveGitPathOverride(null);
    expect(await loadGitPathOverride()).toBeNull();
  });

  it("stores it under whichever config dir is current", async () => {
    await saveGitPathOverride("/somewhere/git");
    const other = path.join(os.tmpdir(), `gitwebui-gitpath-other-${randomBytes(6).toString("hex")}`);
    setConfigDir(other);
    try {
      expect(await loadGitPathOverride()).toBeNull();
    } finally {
      setConfigDir(dir);
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

describe("finding git", () => {
  it("finds the one on this machine", async () => {
    // Every other suite in this project shells out to git, so if this fails the
    // rest of the tests were never going to pass either.
    const found = await resolveGitPath();
    expect(found).not.toBeNull();
    expect(await isUsableGit(found!)).toBe(true);
  });

  it("prefers an explicit environment override", async () => {
    const real = await resolveGitPath();
    expect(real).not.toBeNull();
    process.env.GITWEBUI_GIT_PATH = real!;
    expect(await resolveGitPath()).toBe(real);
  });

  it("prefers a saved choice over searching", async () => {
    const real = await resolveGitPath();
    await saveGitPathOverride(real!);
    expect(await resolveGitPath()).toBe(real);
  });

  it("falls past an override that no longer works", async () => {
    // A pinned path that has since been uninstalled must not poison every git
    // call that follows — the search carries on without it.
    await saveGitPathOverride("/gone/missing/git");
    const found = await resolveGitPath();
    expect(found).not.toBeNull();
    expect(found).not.toBe("/gone/missing/git");
  });
});
