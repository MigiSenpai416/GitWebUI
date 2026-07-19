import type { RepoInfo } from "./git/repo.js";

/**
 * The single active repository for this server process. GitWebUI is a
 * local, single-repo-at-a-time tool, so a module-level value is sufficient.
 */
let active: RepoInfo | null = null;

export function setActiveRepo(info: RepoInfo): void {
  active = info;
}

export function getActiveRepo(): RepoInfo | null {
  return active;
}

/** Returns the repo root, throwing a typed error if no repo is open. */
export function requireRepoRoot(): string {
  if (!active) {
    const err = new Error("No repository is open") as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  return active.root;
}
