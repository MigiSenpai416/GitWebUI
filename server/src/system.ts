import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";

/** Ensure `relPath` resolves inside `root`, returning the absolute path. */
function resolveInRepo(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    const err = new Error("Path is outside the repository") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return abs;
}

/**
 * Open a folder (repo-relative) in the host's file manager. Runs on the machine
 * hosting GitWebUI — the intended "local tool" behavior, matching Open Folder in
 * a desktop git client.
 */
export async function revealFolder(root: string, relPath: string): Promise<void> {
  const abs = resolveInRepo(root, relPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) {
    const err = new Error("Folder no longer exists") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const dir = stat.isDirectory() ? abs : path.dirname(abs);
  launch(dir);
}

function launch(target: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "win32"
      ? ["explorer.exe", [target]]
      : platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  // Detach so the file manager outlives this request; ignore its I/O.
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // don't crash the server if the opener is missing
  child.unref();
}
