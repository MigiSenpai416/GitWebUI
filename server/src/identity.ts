import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.js";

/**
 * The name + email git records as the author/committer. Stored in the app
 * config dir and injected per-commit via `git -c user.name -c user.email`, so
 * we never mutate the user's repo or global git config. When a GitHub account
 * is connected, its identity takes precedence (resolved in routes).
 */
export interface CommitIdentity {
  name: string;
  email: string;
}

const FILE = path.join(CONFIG_DIR, "identity.json");

let cache: CommitIdentity | null = null;
let loaded = false;

async function read(): Promise<CommitIdentity | null> {
  if (loaded) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<CommitIdentity>;
    cache = parsed.name && parsed.email ? { name: parsed.name, email: parsed.email } : null;
  } catch {
    cache = null;
  }
  loaded = true;
  return cache;
}

export async function getIdentity(): Promise<CommitIdentity | null> {
  return read();
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

export async function setIdentity(name: string, email: string): Promise<CommitIdentity> {
  const n = name.trim();
  const e = email.trim();
  if (!n) throw badRequest("A name is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badRequest("A valid email is required");
  const identity = { name: n, email: e };
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(identity, null, 2), "utf8");
  cache = identity;
  loaded = true;
  return identity;
}

export async function clearIdentity(): Promise<void> {
  await fs.rm(FILE, { force: true });
  cache = null;
  loaded = true;
}

/** Test hook to reset the in-memory cache. */
export function _resetIdentityCache(): void {
  cache = null;
  loaded = false;
}
