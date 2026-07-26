import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { configPath, ensureConfigDir } from "../config.js";

/**
 * Which `git` to run.
 *
 * A server started from a shell inherits that shell's PATH, so a bare `git`
 * finds the right binary and there is nothing to resolve — that stays the
 * default, and headless behaviour on every platform is unchanged. An app
 * launched from a desktop shell may not be so lucky: on Windows a PATH change
 * made after login won't have reached an already-running Explorer.
 *
 * So the desktop entry point calls `resolveGitPath()` once at startup and hands
 * the answer to `setGitPath()`. Everything after that goes through `gitPath()`,
 * which is synchronous and never touches the disk — it is read on every git
 * invocation.
 */

const execFileAsync = promisify(execFile);

/** How long a probe (`git --version`, `which git`, the login shell) may take. */
const PROBE_TIMEOUT_MS = 3000;

let override: string | null = null;

/**
 * Pin the git executable. `null` restores the default of resolving `git`
 * through PATH.
 */
export function setGitPath(p: string | null): void {
  override = p;
}

/** The git executable to run. Defaults to `git`, resolved through PATH. */
export function gitPath(): string {
  return override ?? process.env.GITWEBUI_GIT_PATH ?? "git";
}

/** Whether a git binary has been pinned (as opposed to relying on PATH). */
export function hasGitPathOverride(): boolean {
  return override !== null;
}

// ---------------------------------------------------------------------------
// Persisted override
// ---------------------------------------------------------------------------

const overrideFile = () => configPath("git-path.json");

/** The path the user picked in a previous session, if any. */
export async function loadGitPathOverride(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(overrideFile(), "utf8")) as { path?: unknown };
    return typeof parsed.path === "string" && parsed.path ? parsed.path : null;
  } catch {
    return null;
  }
}

/** Remember the user's choice. `null` forgets it and goes back to PATH. */
export async function saveGitPathOverride(p: string | null): Promise<void> {
  if (p === null) {
    await fs.rm(overrideFile(), { force: true });
    return;
  }
  await ensureConfigDir();
  await fs.writeFile(overrideFile(), JSON.stringify({ path: p }, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * On a Mac with no Command Line Tools installed, `/usr/bin/git` exists but is a
 * stub that pops a GUI installer and exits non-zero. `GIT_TERMINAL_PROMPT=0`
 * does not suppress it, so it must never be *run* to be tested — the presence
 * of a developer directory is what tells the two apart.
 */
async function commandLineToolsInstalled(): Promise<boolean> {
  try {
    await execFileAsync("xcode-select", ["-p"], { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Whether running this path would hit the Command Line Tools stub. */
async function isXcodeStub(candidate: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (path.resolve(candidate) !== "/usr/bin/git") return false;
  return !(await commandLineToolsInstalled());
}

/**
 * Does this path actually run git? Confirmed by output rather than exit code
 * alone, so a wrapper script that happens to exit 0 isn't mistaken for git.
 */
export async function isUsableGit(candidate: string): Promise<boolean> {
  if (await isXcodeStub(candidate)) return false;
  try {
    const { stdout } = await execFileAsync(candidate, ["--version"], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return /^git version /i.test(stdout.trim());
  } catch {
    return false;
  }
}

/** Where git usually lands when it isn't on PATH. */
function commonLocations(): string[] {
  if (process.platform === "win32") {
    const roots = [
      process.env.ProgramFiles,
      process.env.ProgramW6432,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : undefined,
      "C:\\Program Files",
      "C:\\Program Files (x86)",
    ].filter((r): r is string => Boolean(r));
    // `cmd\git.exe` is the wrapper Git for Windows puts on PATH; `bin\git.exe`
    // is the MSYS build behind it and drags its own runtime into scope.
    return roots.flatMap((root) => [
      path.join(root, "Git", "cmd", "git.exe"),
      path.join(root, "Git", "bin", "git.exe"),
    ]);
  }
  if (process.platform === "darwin") {
    return [
      "/opt/homebrew/bin/git", // Apple silicon Homebrew
      "/usr/local/bin/git", // Intel Homebrew, and most manual installs
      "/opt/local/bin/git", // MacPorts
      "/usr/bin/git", // Command Line Tools — may be the stub, checked above
    ];
  }
  return ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
}

/** Ask the OS where `git` is on the current PATH. */
async function fromPath(): Promise<string[]> {
  const [cmd, args] =
    process.platform === "win32" ? ["where", ["git.exe"]] : ["which", ["-a", "git"]];
  try {
    const { stdout } = await execFileAsync(cmd as string, args as string[], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Find a usable git, best first. Returns `null` when there isn't one, which is
 * a "tell the user to install git" answer rather than an error.
 *
 * Order: an explicit override (env or a previous session's choice) wins over
 * everything, then whatever PATH resolves to, then the usual install
 * locations. Every candidate is verified by running it, so a stale override or
 * a leftover entry in PATH falls through to the next instead of poisoning
 * every git call that follows.
 */
export async function resolveGitPath(): Promise<string | null> {
  const tried = new Set<string>();
  const check = async (candidate: string | null | undefined): Promise<string | null> => {
    if (!candidate) return null;
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (tried.has(key)) return null;
    tried.add(key);
    return (await isUsableGit(candidate)) ? candidate : null;
  };

  const explicit =
    (await check(process.env.GITWEBUI_GIT_PATH)) ?? (await check(await loadGitPathOverride()));
  if (explicit) return explicit;

  for (const candidate of await fromPath()) {
    const found = await check(candidate);
    if (found) return found;
  }
  for (const candidate of commonLocations()) {
    const found = await check(candidate);
    if (found) return found;
  }
  return null;
}

/** Test hook: forget any pinned path. */
export function _resetGitPath(): void {
  override = null;
}
