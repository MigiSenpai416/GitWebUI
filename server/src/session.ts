import type { Request } from "express";
import type { RepoInfo } from "./git/repo.js";

/**
 * Registry of repositories currently open in the client's tabs. GitWebUI now
 * supports multiple repos at once: each API request names its target repo via
 * the `X-Repo-Root` header, and this map holds the repos that have been opened
 * (and validated) this process. The map survives across tab switches; it is
 * repopulated lazily by the resolve-repo middleware after a server restart.
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

/** The repo root named by this request's `X-Repo-Root` header, if any. */
export function requestedRoot(req: Request): string {
  return String(req.header("x-repo-root") ?? "").trim();
}

/** Resolve the repo this request targets, throwing a typed 409 if none is open. */
export function requireRepo(req: Request): RepoInfo {
  const root = requestedRoot(req);
  const info = root ? opened.get(root) : undefined;
  if (!info) {
    const err = new Error("No repository is open") as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  return info;
}

export function requireRepoRoot(req: Request): string {
  return requireRepo(req).root;
}
