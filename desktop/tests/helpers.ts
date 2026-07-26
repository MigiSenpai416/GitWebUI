import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Launching the app under test, in isolation from the developer's own copy.
 *
 * Isolation is not automatic and getting it wrong is quiet. The app pins its
 * Electron profile to a fixed directory and serves itself from a fixed port,
 * which together make the origin stable — that is what lets it remember open
 * tabs between launches. The cost is that a test launched with the defaults
 * shares both with the installed app: it would read the developer's real open
 * tabs (and could pass because of them) and overwrite them on the way out.
 *
 * So every launch here gets three throwaway things: a config directory, an
 * Electron profile, and a port of its own.
 */

const desktopDir = path.resolve(__dirname, "..");
const mainEntry = path.join(desktopDir, "dist", "main.js");

/**
 * The port the tests use. Deliberately not 5175: an installed copy may be open
 * while the suite runs, and being pushed onto a fallback port would move the
 * origin between launches — exactly what the persistence test checks against.
 */
const TEST_PORT = "5176";

export interface TestApp {
  app: ElectronApplication;
  /** Config dir (repos, auth, token) — server-side state. */
  configDir: string;
  /** Electron profile (localStorage, caches) — renderer-side state. */
  userDataDir: string;
}

export interface LaunchOptions {
  /**
   * Reuse an earlier launch's directories, so the app sees the state it left
   * behind. This is what makes a restart a restart rather than a fresh install.
   */
  reuse?: Pick<TestApp, "configDir" | "userDataDir">;
}

/** Launch the app — the packaged binary when `GITWEBUI_E2E_BINARY` names one. */
export async function launchApp(options: LaunchOptions = {}): Promise<TestApp> {
  const id = randomBytes(6).toString("hex");
  const configDir = options.reuse?.configDir ?? path.join(os.tmpdir(), `gitwebui-e2e-cfg-${id}`);
  const userDataDir =
    options.reuse?.userDataDir ?? path.join(os.tmpdir(), `gitwebui-e2e-profile-${id}`);

  const packaged = process.env.GITWEBUI_E2E_BINARY;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged, args: [] } : { args: [mainEntry] }),
    env: {
      ...process.env,
      GITWEBUI_CONFIG_DIR: configDir,
      GITWEBUI_USER_DATA_DIR: userDataDir,
      GITWEBUI_DESKTOP_PORT: TEST_PORT,
    },
  });

  return { app, configDir, userDataDir };
}

/** Remove a launch's directories. Safe to call for a reused pair, once. */
export async function cleanupApp(app: Pick<TestApp, "configDir" | "userDataDir">): Promise<void> {
  await fs.rm(app.configDir, { recursive: true, force: true });
  await fs.rm(app.userDataDir, { recursive: true, force: true });
}

/** A throwaway repository with one commit, so the app has something to show. */
export function makeRepo(): string {
  const dir = path.join(os.tmpdir(), `gitwebui-e2e-repo-${randomBytes(6).toString("hex")}`);
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "e2e@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "End To End"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "first commit"], {
    stdio: "pipe",
  });
  return dir;
}

export async function removeRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
