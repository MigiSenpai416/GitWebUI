import type { RepoInfo } from "./git/repo.js";

/**
 * Registry of repositories currently open in the client's tabs. GitWebUI
 * supports multiple repos at once: each call names its target repo by root,
 * and this map holds the repos that have been opened (and validated) this
 * process. The map survives across tab switches; it is repopulated lazily by
 * `dispatch()` when a restored tab names a repo this process hasn't seen.
 */
const opened = new Map<string, RepoInfo>();

export function registerRepo(info: RepoInfo): RepoInfo {
  opened.set(info.root, info);
  return info;
}

export function unregisterRepo(root: string): void {
  opened.delete(root);
}

export function getRepoByRoot(root: string): RepoInfo | undefined {
  return opened.get(root);
}

/** Resolve the repo a call targets, throwing a typed 409 if none is open. */
export function requireRepo(root: string): RepoInfo {
  const info = root ? opened.get(root.trim()) : undefined;
  if (!info) {
    const err = new Error("No repository is open") as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  return info;
}

export function requireRepoRoot(root: string): string {
  return requireRepo(root).root;
}
