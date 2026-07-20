import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Directory where GitWebUI persists its state (recent repos, auth). Resolved
 * per-OS so it works the same for a `node`/`tsx` run and a compiled binary.
 */
export const CONFIG_DIR =
  process.env.GITWEBUI_CONFIG_DIR ||
  path.join(
    process.env.APPDATA ||
      process.env.XDG_CONFIG_HOME ||
      path.join(os.homedir(), ".config"),
    "gitwebui",
  );
const CONFIG_FILE = path.join(CONFIG_DIR, "recent.json");
const MAX_RECENT = 15;

interface ConfigShape {
  recent: string[];
}

async function read(): Promise<ConfigShape> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigShape>;
    return { recent: Array.isArray(parsed.recent) ? parsed.recent : [] };
  } catch {
    return { recent: [] };
  }
}

async function write(cfg: ConfigShape): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
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
