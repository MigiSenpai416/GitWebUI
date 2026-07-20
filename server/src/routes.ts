import { Router, type Request, type Response, type NextFunction } from "express";
import { openRepo } from "./git/repo.js";
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
import { currentBranch, headHash } from "./git/repo.js";
import { getActiveRepo, setActiveRepo, requireRepoRoot } from "./session.js";
import { getRecent, addRecent } from "./config.js";
import { GitError } from "./git/gitRunner.js";

export const api = Router();

// Wrap async handlers so rejections reach the error middleware.
function h(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

api.get("/repo/current", h(async (_req, res) => {
  res.json({ repo: getActiveRepo() });
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
  const info = await openRepo(path);
  setActiveRepo(info);
  await addRecent(info.root);
  res.json({ repo: info });
}));

api.get("/commits", h(async (req, res) => {
  const root = requireRepoRoot();
  const limit = clampInt(req.query.limit, 100, 1, 1000);
  const skip = clampInt(req.query.skip, 0, 0, Number.MAX_SAFE_INTEGER);
  if (!getActiveRepo()?.head) {
    res.json({ commits: [], hasMore: false });
    return;
  }
  const commits = await getLog(root, skip, limit + 1);
  const hasMore = commits.length > limit;
  res.json({ commits: hasMore ? commits.slice(0, limit) : commits, hasMore });
}));

api.get("/commits/:hash/files", h(async (req, res) => {
  const root = requireRepoRoot();
  const files = await getCommitFiles(root, req.params.hash);
  res.json({ files });
}));

api.get("/status", h(async (_req, res) => {
  const root = requireRepoRoot();
  res.json(await getStatus(root));
}));

api.get("/branches", h(async (_req, res) => {
  const root = requireRepoRoot();
  res.json({ branches: await getBranches(root) });
}));

api.post("/checkout", h(async (req, res) => {
  const root = requireRepoRoot();
  const name = String(req.body?.branch ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "A branch name is required" });
    return;
  }
  await checkoutBranch(root, name);
  await refreshSession(root);
  res.json({ repo: getActiveRepo() });
}));

api.post("/branch/create", h(async (req, res) => {
  const root = requireRepoRoot();
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
  await refreshSession(root);
  res.json({ repo: getActiveRepo() });
}));

api.post("/branch/delete", h(async (req, res) => {
  const root = requireRepoRoot();
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "A branch name is required" });
    return;
  }
  await deleteBranch(root, name);
  res.json({ branches: await getBranches(root) });
}));

api.post("/reset", h(async (req, res) => {
  const root = requireRepoRoot();
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
  await refreshSession(root);
  res.json({ repo: getActiveRepo() });
}));

api.post("/revert", h(async (req, res) => {
  const root = requireRepoRoot();
  const hash = String(req.body?.hash ?? "").trim();
  if (!hash) {
    res.status(400).json({ error: "A commit is required" });
    return;
  }
  await revertCommit(root, hash);
  await refreshSession(root);
  res.json({ repo: getActiveRepo() });
}));

api.post("/discard", h(async (_req, res) => {
  const root = requireRepoRoot();
  await discardAll(root);
  res.json(await getStatus(root));
}));

api.get("/diff", h(async (req, res) => {
  const root = requireRepoRoot();
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
  const root = requireRepoRoot();
  const paths = asStringArray(req.body?.paths);
  if (req.body?.all) {
    await stageAll(root);
  } else {
    await stagePaths(root, paths);
  }
  res.json(await getStatus(root));
}));

api.post("/unstage", h(async (req, res) => {
  const root = requireRepoRoot();
  const paths = asStringArray(req.body?.paths);
  await unstagePaths(root, paths);
  res.json(await getStatus(root));
}));

api.post("/commit", h(async (req, res) => {
  const root = requireRepoRoot();
  const title = String(req.body?.title ?? "");
  const description = String(req.body?.description ?? "");
  const amend = Boolean(req.body?.amend);
  const hash = await commit(root, { title, description, amend });
  const status = await getStatus(root);
  res.json({ hash, status });
}));

/** Re-read the active branch and HEAD into the session after a ref-moving op. */
async function refreshSession(root: string): Promise<void> {
  const active = getActiveRepo();
  if (active) {
    active.branch = await currentBranch(root);
    active.head = await headHash(root);
    setActiveRepo(active);
  }
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
