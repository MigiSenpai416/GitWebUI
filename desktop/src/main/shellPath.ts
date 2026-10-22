import { execFile } from "node:child_process";
import { log } from "./log.js";

/**
 * Give the app the PATH a terminal would have.
 *
 * An app launched from the Finder or the Dock gets launchd's PATH —
 * /usr/bin:/bin:/usr/sbin:/sbin — not the user's. git itself is found
 * regardless (gitPath.ts knows the Homebrew locations), but everything git and
 * the terminal panel go on to look up by name is not: git-filter-repo, git-lfs,
 * gpg for signed commits, the node behind a repository's hooks. So on macOS
 * the user's login shell is asked for its PATH once at startup, the way editors
 * on the platform do, and the answer is handed to every child process through
 * process.env. Bounded, because a broken shell profile must not stall the app:
 * on any failure the well-known Homebrew directories are added instead.
 */

const SHELL_TIMEOUT_MS = 3_000;
const HOMEBREW_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];

function loginShellPath(): Promise<string> {
  return new Promise((resolve, reject) => {
    // A login shell reads ~/.zprofile, which is where Homebrew's shellenv is
    // meant to go; not an interactive one, so no rc-file chatter and no prompt.
    execFile(
      process.env.SHELL || "/bin/zsh",
      ["-lc", 'printf "%s" "$PATH"'],
      { timeout: SHELL_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Merge `dirs` ahead of the current PATH, keeping each entry once. */
export function mergePath(dirs: string[], current: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...dirs, ...current.split(":")]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(":");
}

export async function adoptLoginShellPath(): Promise<void> {
  if (process.platform !== "darwin") return;
  let dirs: string[];
  try {
    const found = await loginShellPath();
    if (!found.includes("/")) throw new Error("the shell printed no PATH");
    dirs = found.split(":");
    log.info(`PATH taken from the login shell (${dirs.length} entries)`);
  } catch (error) {
    dirs = HOMEBREW_DIRS;
    log.info(`login shell PATH unavailable (${error instanceof Error ? error.message : error}); adding the Homebrew directories`);
  }
  process.env.PATH = mergePath(dirs, process.env.PATH ?? "");
}
