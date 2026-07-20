import { Router, type Request, type Response, type NextFunction } from "express";
import { openRepo, currentBranch, headHash, type RepoInfo } from "./git/repo.js";
import { getLog } from "./git/log.js";
import { getStatus } from "./git/status.js";
import { getCommitFiles } from "./git/commitFiles.js";
import { getDiff, type DiffSource } from "./git/diff.js";
import {
  stagePaths,
  stageAll,
  unstagePaths,
  commit,
  discardAll,
  resetTo,
  revertCommit,
  type ResetMode,
} from "./git/mutate.js";
import { getBranches, checkoutBranch, createBranchAt, deleteBranch } from "./git/branches.js";
import {
  getRemotes,
  addRemote,
  setRemoteUrl,
  removeRemote,
  push,
  pull,
  cloneRepo,
  createGitHubRemote,
} from "./git/remote.js";
import * as github from "./github.js";
import { getStashes, stashPush, stashPop, stashApply, stashDrop } from "./git/stash.js";
import {
  registerRepo,
  unregisterRepo,
  getRepoByRoot,
  requestedRoot,
  requireRepo,
  requireRepoRoot,
} from "./session.js";
import { getRecent, addRecent } from "./config.js";
import { GitError } from "./git/gitRunner.js";

export const api = Router();

// Wrap async handlers so rejections reach the error middleware.
function h(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/**
 * If a request names a repo that isn't registered yet (e.g. after a server
 * restart while the client still has the tab open), re-validate and register
 * it transparently so data routes keep working without a re-open round-trip.
 */
api.use((req: Request, _res: Response, next: NextFunction) => {
  const root = requestedRoot(req);
  if (!root || getRepoByRoot(root)) return next();
  openRepo(root)
    .then((info) => registerRepo(info))
    .catch(() => undefined) // leave unregistered → requireRepo throws a clean 409
    .finally(next);
});

api.get("/repo/current", h(async (req, res) => {
  const root = requestedRoot(req);
  res.json({ repo: root ? getRepoByRoot(root) ?? null : null });
}));

api.get("/repo/recent", h(async (_req, res) => {
  res.json({ recent: await getRecent() });
}));

api.post("/repo/open", h(async (req, res) => {
  const path = String(req.body?.path ?? "").trim();
  if (!path) {
    res.status(400).json({ error: "A repository path is required" });
    return;
  }
  const info = registerRepo(await openRepo(path));
  await addRecent(info.root);
  res.json({ repo: info });
}));

api.post("/repo/clone", h(async (req, res) => {
  const dir = String(req.body?.dir ?? "").trim();
  const url = String(req.body?.url ?? "").trim();
  if (!dir || !url) {
    res.status(400).json({ error: "A destination folder and a URL are required" });
    return;
  }
  const info = registerRepo(await cloneRepo(dir, url));
  await addRecent(info.root);
  res.json({ repo: info });
}));

api.post("/repo/close", h(async (req, res) => {
  const root = String(req.body?.root ?? "").trim();
  if (root) unregisterRepo(root);
  res.json({ ok: true });
}));

api.get("/commits", h(async (req, res) => {
  const repo = requireRepo(req);
  const root = repo.root;
  const limit = clampInt(req.query.limit, 100, 1, 1000);
  const skip = clampInt(req.query.skip, 0, 0, Number.MAX_SAFE_INTEGER);
  if (!repo.head) {
    res.json({ commits: [], hasMore: false });
    return;
  }
  const commits = await getLog(root, skip, limit + 1);
  const hasMore = commits.length > limit;
  res.json({ commits: hasMore ? commits.slice(0, limit) : commits, hasMore });
}));

api.get("/commits/:hash/files", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const files = await getCommitFiles(root, req.params.hash);
  res.json({ files });
}));

api.get("/status", h(async (req, res) => {
  const root = requireRepoRoot(req);
  res.json(await getStatus(root));
}));

api.get("/branches", h(async (req, res) => {
  const root = requireRepoRoot(req);
  res.json({ branches: await getBranches(root) });
}));

api.post("/checkout", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const name = String(req.body?.branch ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "A branch name is required" });
    return;
  }
  await checkoutBranch(root, name);
  res.json({ repo: await refreshSession(root) });
}));

api.post("/branch/create", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const name = String(req.body?.name ?? "").trim();
  const hash = String(req.body?.hash ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "A branch name is required" });
    return;
  }
  if (!hash) {
    res.status(400).json({ error: "A commit is required" });
    return;
  }
  await createBranchAt(root, name, hash);
  res.json({ repo: await refreshSession(root) });
}));

api.post("/branch/delete", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "A branch name is required" });
    return;
  }
  await deleteBranch(root, name);
  res.json({ branches: await getBranches(root) });
}));

api.post("/reset", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const hash = String(req.body?.hash ?? "").trim();
  const mode = String(req.body?.mode ?? "") as ResetMode;
  if (!hash) {
    res.status(400).json({ error: "A commit is required" });
    return;
  }
  if (!["hard", "soft", "mixed"].includes(mode)) {
    res.status(400).json({ error: "mode must be hard, soft, or mixed" });
    return;
  }
  await resetTo(root, hash, mode);
  res.json({ repo: await refreshSession(root) });
}));

api.post("/revert", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const hash = String(req.body?.hash ?? "").trim();
  if (!hash) {
    res.status(400).json({ error: "A commit is required" });
    return;
  }
  await revertCommit(root, hash);
  res.json({ repo: await refreshSession(root) });
}));

api.post("/discard", h(async (req, res) => {
  const root = requireRepoRoot(req);
  await discardAll(root);
  res.json(await getStatus(root));
}));

api.get("/diff", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const source = String(req.query.source ?? "") as DiffSource;
  const path = String(req.query.path ?? "");
  const hash = req.query.hash ? String(req.query.hash) : undefined;
  if (!["unstaged", "staged", "commit"].includes(source) || !path) {
    res.status(400).json({ error: "source and path are required" });
    return;
  }
  res.json(await getDiff(root, source, path, hash));
}));

api.post("/stage", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const paths = asStringArray(req.body?.paths);
  if (req.body?.all) {
    await stageAll(root);
  } else {
    await stagePaths(root, paths);
  }
  res.json(await getStatus(root));
}));

api.post("/unstage", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const paths = asStringArray(req.body?.paths);
  await unstagePaths(root, paths);
  res.json(await getStatus(root));
}));

api.post("/commit", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const title = String(req.body?.title ?? "");
  const description = String(req.body?.description ?? "");
  const amend = Boolean(req.body?.amend);
  const hash = await commit(root, { title, description, amend });
  const status = await getStatus(root);
  res.json({ hash, status });
}));

// ---- GitHub account (Personal Access Token) ----

api.get("/github/status", h(async (_req, res) => {
  res.json(await github.status());
}));

api.post("/github/token", h(async (req, res) => {
  const token = String(req.body?.token ?? "").trim();
  if (!token) {
    res.status(400).json({ error: "A token is required" });
    return;
  }
  // Validate the token against the GitHub API before storing it.
  const user = await github.fetchUser(token);
  await github.setToken(token);
  res.json({ configured: true, user });
}));

api.delete("/github/token", h(async (_req, res) => {
  await github.deleteToken();
  res.json({ configured: false, user: null });
}));

api.get("/github/repos", h(async (_req, res) => {
  const token = await github.getToken();
  if (!token) {
    res.status(401).json({ error: "Connect a GitHub account first" });
    return;
  }
  res.json({ repos: await github.listRepos(token) });
}));

// ---- Remotes ----

api.get("/remotes", h(async (req, res) => {
  const root = requireRepoRoot(req);
  res.json({ remotes: await getRemotes(root) });
}));

api.post("/remote/add", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const name = String(req.body?.name ?? "").trim();
  const url = String(req.body?.url ?? "").trim();
  if (!name || !url) {
    res.status(400).json({ error: "A remote name and URL are required" });
    return;
  }
  const existing = await getRemotes(root);
  if (existing.some((r) => r.name === name)) {
    await setRemoteUrl(root, name, url);
  } else {
    await addRemote(root, name, url);
  }
  res.json({ remotes: await getRemotes(root) });
}));

api.post("/remote/remove", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "A remote name is required" });
    return;
  }
  await removeRemote(root, name);
  res.json({ remotes: await getRemotes(root) });
}));

api.post("/github/create-repo", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "A repository name is required" });
    return;
  }
  const result = await createGitHubRemote(root, {
    name,
    description: String(req.body?.description ?? "").trim(),
    private: Boolean(req.body?.private),
    remoteName: String(req.body?.remoteName ?? "origin").trim() || "origin",
  });
  await refreshSession(root);
  res.json(result);
}));

// ---- Stash ----

api.get("/stashes", h(async (req, res) => {
  const root = requireRepoRoot(req);
  res.json({ stashes: await getStashes(root) });
}));

api.post("/stash/push", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const message = String(req.body?.message ?? "");
  const result = await stashPush(root, { message });
  res.json({ ...result, status: await getStatus(root), stashes: await getStashes(root) });
}));

api.post("/stash/pop", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const index = clampInt(req.body?.index, 0, 0, Number.MAX_SAFE_INTEGER);
  const result = await stashPop(root, index);
  res.json({ ...result, status: await getStatus(root), stashes: await getStashes(root) });
}));

api.post("/stash/apply", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const index = clampInt(req.body?.index, 0, 0, Number.MAX_SAFE_INTEGER);
  const result = await stashApply(root, index);
  res.json({ ...result, status: await getStatus(root), stashes: await getStashes(root) });
}));

api.post("/stash/drop", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const index = clampInt(req.body?.index, 0, 0, Number.MAX_SAFE_INTEGER);
  await stashDrop(root, index);
  res.json({ stashes: await getStashes(root) });
}));

// ---- Push / Pull ----

api.post("/push", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const result = await push(root);
  await refreshSession(root);
  res.json({ ...result, branches: await getBranches(root) });
}));

api.post("/pull", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const result = await pull(root);
  await refreshSession(root);
  res.json(result);
}));

/** Re-read the branch and HEAD into the registry after a ref-moving op. */
async function refreshSession(root: string): Promise<RepoInfo | null> {
  const info = getRepoByRoot(root);
  if (!info) return null;
  info.branch = await currentBranch(root);
  info.head = await headHash(root);
  return registerRepo(info);
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ""), 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter((s) => s.length > 0);
  if (typeof v === "string" && v) return [v];
  return [];
}

// Centralized error handler: git failures and missing-repo become clean JSON.
export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = (err as { status?: number }).status ?? (err instanceof GitError ? 422 : 500);
  const message = err instanceof Error ? err.message : "Internal error";
  res.status(status).json({ error: message });
}
