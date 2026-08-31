import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Directory where GitWebUI persists its state (recent repos, auth, GitHub
 * token, commit identity). Resolved per-OS so it works the same for a
 * `node`/`tsx` run, a compiled binary, and the desktop app.
 *
 * Resolved *on every call* rather than once at import time. An embedder — the
 * Electron main process — has to be able to choose the directory before
 * anything reads it, and freezing it at import would make that depend on the
 * order modules happen to be loaded in. Callers therefore ask for a path when
 * they need one instead of capturing it in a module constant.
 */

let overrideDir: string | null = null;

/**
 * Point the config dir somewhere else. Takes precedence over the environment,
 * so an embedder's choice is not silently overridden by a stray env var. Call
 * it before serving requests; it has no effect on caches already populated
 * from the previous location.
 */
export function setConfigDir(dir: string | null): void {
  overrideDir = dir;
}

function platformDefault(): string {
  return path.join(
    process.env.APPDATA ||
      process.env.XDG_CONFIG_HOME ||
      path.join(os.homedir(), ".config"),
    "gitwebui",
  );
}

export function configDir(): string {
  return overrideDir ?? process.env.GITWEBUI_CONFIG_DIR ?? platformDefault();
}

/** Path to a file inside the config dir. */
export function configPath(name: string): string {
  return path.join(configDir(), name);
}

/** Ensure the config dir exists before writing into it. */
export async function ensureConfigDir(): Promise<void> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
}

const MAX_RECENT = 15;

interface ConfigShape {
  recent: string[];
}

async function read(): Promise<ConfigShape> {
  try {
    const raw = await fs.readFile(configPath("recent.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigShape>;
    return { recent: Array.isArray(parsed.recent) ? parsed.recent : [] };
  } catch {
    return { recent: [] };
  }
}

async function write(cfg: ConfigShape): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(configPath("recent.json"), JSON.stringify(cfg, null, 2), "utf8");
}

export async function getRecent(): Promise<string[]> {
  return (await read()).recent;
}

export async function addRecent(repoPath: string): Promise<string[]> {
  const cfg = await read();
  const next = [repoPath, ...cfg.recent.filter((p) => p !== repoPath)].slice(0, MAX_RECENT);
  await write({ recent: next });
  return next;
}
