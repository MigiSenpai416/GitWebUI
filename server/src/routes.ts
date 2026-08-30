import { promises as fsPromises } from "node:fs";
import { Router, type Request, type Response, type NextFunction } from "express";
import { openRepo, createLocalRepo, currentBranch, headHash, type RepoInfo } from "./git/repo.js";
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
  discardPaths,
  deleteFile,
  resetTo,
  revertCommit,
  type ResetMode,
} from "./git/mutate.js";
import { revealFolder, openFolderAbsolute } from "./system.js";
import {
  listWorktrees,
  addWorktree,
  removeWorktree,
  pruneWorktrees,
  samePath,
} from "./git/worktree.js";
import {
  getBranches,
  getRemoteBranches,
  checkoutBranch,
  checkoutRemoteBranch,
  checkoutCommit,
  createBranchAt,
  deleteBranch,
} from "./git/branches.js";
import {
  getRemotes,
  addRemote,
  setRemoteUrl,
  removeRemote,
  push,
  pull,
  deleteRemoteBranch,
  cloneRepo,
  createGitHubRemote,
  createGitHubRepoNew,
  type PushForce,
} from "./git/remote.js";
import * as github from "./github.js";
import {
  githubRemotes,
  findPullRequestTemplates,
  readPullRequestTemplate,
} from "./git/pullRequest.js";
import { getIdentity, setIdentity, clearIdentity, type CommitIdentity } from "./identity.js";
import {
  getStashes,
  stashPush,
  stashPop,
  stashApply,
  stashDrop,
  setStashNote,
  pruneStashNotes,
} from "./git/stash.js";
import {
  getMergeState,
  getConflictFile,
  writeResolution,
  markResolved,
  abortMerge,
  mergeBranch,
  cherryPick,
  conflictedPaths,
  isConflicted,
} from "./git/conflict.js";
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
import {
  beginRepoMutation,
  deletePathFromHistory,
  getHeadFileContent,
  getHeadFileTree,
  isRepoMaintenanceActive,
  pruneRepository,
} from "./git/historyFiles.js";
import { detectShells, pickShell, runCommand } from "./terminal.js";

export const api = Router();
const mutationRelease = Symbol("repoMutationRelease");
type MutationRequest = Request & { [mutationRelease]?: () => void };
type MutationStateRequest = MutationRequest & { mutationHandlerActive?: boolean };

// Wrap async handlers so rejections reach the error middleware.
function h(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const mutationReq = req as MutationStateRequest;
    mutationReq.mutationHandlerActive = true;
    fn(req, res)
      .catch(next)
      .finally(() => {
        mutationReq.mutationHandlerActive = false;
        mutationReq[mutationRelease]?.();
        delete mutationReq[mutationRelease];
      });
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

// History rewriting temporarily replaces every ref. Keep all other app-driven
// mutations (including terminal commands) out of that transaction window.
api.use((req: Request, res: Response, next: NextFunction) => {
  const root = requestedRoot(req);
  const normalizedPath = req.path.replace(/\/+$/, "") || "/";
  const isHistoryDelete = normalizedPath === "/history-files/delete";
  const isRepoPrune = normalizedPath === "/repo/prune";
  const isExclusiveMutation = isHistoryDelete || isRepoPrune;
  if (
    root &&
    req.method !== "GET" &&
    !isExclusiveMutation &&
    isRepoMaintenanceActive(root)
  ) {
    res.status(409).json({ error: "Repository maintenance is running for this repository" });
    return;
  }
  if (root && req.method !== "GET" && !isExclusiveMutation) {
    // Reserve synchronously, before a handler's first await. This closes the
    // window where an admitted terminal/remote request could begin mutating
    // after a history rewrite had already passed preflight.
    const release = beginRepoMutation(root);
    const mutationReq = req as MutationStateRequest;
    mutationReq[mutationRelease] = release;
    const releaseUnclaimed = () => {
      if (mutationReq.mutationHandlerActive) return;
      mutationReq[mutationRelease]?.();
      delete mutationReq[mutationRelease];
    };
    res.once("finish", releaseUnclaimed);
    res.once("close", releaseUnclaimed);
  }
  next();
});

api.get("/repo/current", h(async (req, res) => {
  const root = requestedRoot(req);
  // The registry is a routing cache, not an authoritative view of Git. A
  // terminal command or another Git client can move HEAD without going through
  // one of our mutation routes, so a repository refresh must re-read both the
  // checked-out branch and its tip instead of returning the cached RepoInfo.
  res.json({ repo: root ? await refreshSession(root) : null });
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

api.post("/repo/create", h(async (req, res) => {
  const dir = String(req.body?.dir ?? "").trim();
  const name = String(req.body?.name ?? "").trim();
  const branch = String(req.body?.branch ?? "").trim();
  if (!dir || !name) {
    res.status(400).json({ error: "A parent folder and repository name are required" });
    return;
  }
  const identity = await resolveCommitIdentity();
  const info = registerRepo(await createLocalRepo(dir, name, branch, identity));
  await addRecent(info.root);
  res.json({ repo: info });
}));

api.post("/repo/create-github", h(async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "A repository name is required" });
    return;
  }
  const clone = Boolean(req.body?.clone);
  const identity = await resolveCommitIdentity();
  const { created, repo } = await createGitHubRepoNew({
    name,
    description: String(req.body?.description ?? "").trim(),
    private: Boolean(req.body?.private),
    defaultBranch: String(req.body?.branch ?? "").trim(),
    clone,
    dir: String(req.body?.dir ?? "").trim(),
    identity,
  });
  if (repo) {
    registerRepo(repo);
    await addRecent(repo.root);
  }
  res.json({ created, repo });
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

api.post("/repo/prune", h(async (req, res) => {
  const root = requireRepoRoot(req);
  await pruneRepository(root);
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
  // Extra branch revisions (beyond HEAD) whose commits should also appear.
  const extraRevs = String(req.query.revs ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const commits = await getLog(root, skip, limit + 1, ["HEAD", ...extraRevs]);
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

api.get("/remote-branches", h(async (req, res) => {
  const root = requireRepoRoot(req);
  res.json({ branches: await getRemoteBranches(root) });
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

api.post("/checkout-remote", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const remote = String(req.body?.remote ?? "").trim();
  const local = String(req.body?.local ?? "").trim();
  if (!remote || !local) {
    res.status(400).json({ error: "A remote branch is required" });
    return;
  }
  await checkoutRemoteBranch(root, remote, local);
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

api.post("/remote-branch/delete", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const remote = String(req.body?.remote ?? "").trim();
  const branch = String(req.body?.branch ?? "").trim();
  if (!remote || !branch) {
    res.status(400).json({ error: "A remote and branch name are required" });
    return;
  }
  await deleteRemoteBranch(root, remote, branch);
  res.json({ branches: await getRemoteBranches(root) });
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
  // A revert that conflicts isn't an error — it leaves the revert in progress
  // for the user to resolve, which we surface as merge state.
  try {
    await revertCommit(root, hash);
  } catch (e) {
    if (!(await isConflicted(root))) throw e;
  }
  res.json({
    repo: await refreshSession(root),
    merge: await getMergeState(root),
    status: await getStatus(root),
  });
}));

api.post("/discard", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const paths = asStringArray(req.body?.paths);
  if (paths.length > 0) {
    await discardPaths(root, paths);
  } else {
    await discardAll(root);
  }
  res.json(await getStatus(root));
}));

api.post("/file/delete", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const path = String(req.body?.path ?? "").trim();
  if (!path) {
    res.status(400).json({ error: "A file path is required" });
    return;
  }
  await deleteFile(root, path);
  res.json(await getStatus(root));
}));

// ---- File Manager / history rewrite ----

api.get("/history-files", h(async (req, res) => {
  const root = requireRepoRoot(req);
  res.json(await getHeadFileTree(root, req.query.includeHistory === "true"));
}));

api.get("/history-files/content", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const path = String(req.query.path ?? "");
  const head = String(req.query.head ?? "");
  res.json(await getHeadFileContent(root, path, head));
}));

api.post("/history-files/delete", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const target = String(req.body?.path ?? "");
  const targets = Array.isArray(req.body?.paths)
    ? req.body.paths.map((item: unknown) => String(item ?? ""))
    : undefined;
  const expectedHead = String(req.body?.expectedHead ?? "");
  const confirmation = String(req.body?.confirmation ?? "");
  const recursive = targets ? req.body?.recursive === true : req.body?.recursive !== false;
  const result = await deletePathFromHistory(root, {
    path: target,
    paths: targets,
    expectedHead,
    confirmation,
    recursive,
  });
  res.json({ ...result, repo: await refreshSession(root) });
}));

api.post("/reveal", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const path = String(req.body?.path ?? "").trim();
  await revealFolder(root, path);
  res.json({ ok: true });
}));

// ---- Worktrees ----

api.get("/worktrees", h(async (req, res) => {
  const root = requireRepoRoot(req);
  res.json({ worktrees: await listWorktrees(root) });
}));

api.post("/worktree/add", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const path = String(req.body?.path ?? "").trim();
  const ref = String(req.body?.ref ?? "").trim();
  const branch = String(req.body?.branch ?? "").trim();
  if (!path) {
    res.status(400).json({ error: "A working directory is required" });
    return;
  }
  await addWorktree(root, { path, ref, newBranch: branch });
  res.json({ worktrees: await listWorktrees(root) });
}));

api.post("/worktree/remove", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const path = String(req.body?.path ?? "").trim();
  if (!path) {
    res.status(400).json({ error: "A worktree path is required" });
    return;
  }
  await removeWorktree(root, path);
  res.json({ worktrees: await listWorktrees(root) });
}));

api.post("/worktree/prune", h(async (req, res) => {
  const root = requireRepoRoot(req);
  await pruneWorktrees(root);
  res.json({ worktrees: await listWorktrees(root) });
}));

api.post("/worktree/reveal", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const path = String(req.body?.path ?? "").trim();
  // Only reveal a directory that is actually a worktree of this repo.
  const worktrees = await listWorktrees(root);
  if (!path || !worktrees.some((w) => samePath(w.path, path))) {
    res.status(400).json({ error: "Unknown worktree" });
    return;
  }
  await openFolderAbsolute(path);
  res.json({ ok: true });
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
  const identity = await resolveCommitIdentity();
  const hash = await commit(root, { title, description, amend, identity });
  const status = await getStatus(root);
  // A first commit moves an unborn repository from head=null to a real HEAD;
  // amend moves HEAD as well. Keep the registry authoritative before the client
  // reloads /commits, whose unborn-repo fast path reads this metadata.
  const repo = await refreshSession(root);
  res.json({ hash, status, repo });
}));

// ---- Commit identity ----

/** Effective commit identity: the connected GitHub account, else the manual one. */
async function resolveCommitIdentity(): Promise<CommitIdentity | null> {
  return (await github.githubIdentity()) ?? (await getIdentity());
}

api.get("/identity", h(async (_req, res) => {
  const [manual, gh] = await Promise.all([getIdentity(), github.githubIdentity()]);
  res.json({ manual, github: gh, effective: gh ?? manual ?? null });
}));

api.post("/identity", h(async (req, res) => {
  const name = String(req.body?.name ?? "");
  const email = String(req.body?.email ?? "");
  const manual = await setIdentity(name, email);
  const gh = await github.githubIdentity();
  res.json({ manual, github: gh, effective: gh ?? manual });
}));

api.delete("/identity", h(async (_req, res) => {
  await clearIdentity();
  const gh = await github.githubIdentity();
  res.json({ manual: null, github: gh, effective: gh ?? null });
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

// ---- Pull requests (GitHub) ----

/** How many GitHub remotes we resolve against the API when opening the dialog. */
const MAX_PR_REPOS = 5;

/**
 * Wrap a pull-request handler so a rejected GitHub token surfaces as 403. The
 * web client treats ANY 401 as "the GitWebUI session expired" and drops to the
 * login screen (see api/client.ts) — a GitHub auth failure must not sign the
 * user out of the app itself.
 */
function gh(fn: (req: Request, res: Response) => Promise<void>) {
  return h(async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if ((e as { status?: number }).status !== 401) throw e;
      const message = e instanceof Error ? e.message : "GitHub authentication failed";
      throw Object.assign(
        new Error(`${message} — reconnect your GitHub account in Actions → GitHub.`),
        { status: 403 },
      );
    }
  });
}

async function requireGitHubToken(): Promise<string> {
  const token = await github.getToken();
  if (!token) throw Object.assign(new Error("Connect a GitHub account first"), { status: 403 });
  return token;
}

/** Parse an "owner/name" request parameter. */
function repoParam(v: unknown): { owner: string; repo: string } {
  const [owner, repo] = String(v ?? "").trim().split("/");
  if (!owner || !repo) {
    throw Object.assign(new Error("A repository (owner/name) is required"), { status: 400 });
  }
  return { owner, repo };
}

api.get("/pr/context", gh(async (req, res) => {
  const root = requireRepoRoot(req);
  const token = await requireGitHubToken();
  const [remotes, branches, templates, branch] = await Promise.all([
    githubRemotes(root),
    getBranches(root),
    findPullRequestTemplates(root),
    currentBranch(root),
  ]);

  // Resolve each GitHub remote against the API; an inaccessible one is skipped
  // rather than failing the whole dialog.
  const resolved = await Promise.all(
    remotes.slice(0, MAX_PR_REPOS).map(async (r) => {
      try {
        return { remote: r.remote, ref: await github.fetchRepo(token, r.owner, r.repo) };
      } catch {
        return null;
      }
    }),
  );
  const live = resolved.filter((x): x is { remote: string; ref: github.GitHubRepoRef } => x !== null);
  const byFullName = new Map<string, github.GitHubRepoRef>();
  for (const { ref } of live) byFullName.set(ref.fullName, ref);

  // A fork's upstream is the usual PR target, so offer it as a base candidate.
  for (const { ref } of live) {
    if (!ref.parentFullName || byFullName.has(ref.parentFullName)) continue;
    const [owner, name] = ref.parentFullName.split("/");
    try {
      const parent = await github.fetchRepo(token, owner, name);
      byFullName.set(parent.fullName, parent);
    } catch {
      /* parent deleted or not visible to this token */
    }
  }

  // Prefer the remote the current branch tracks, then origin, then whatever exists.
  const upstreamRemote = branches.find((b) => b.current)?.upstream?.split("/")[0] ?? null;
  const headEntry =
    live.find((x) => x.remote === upstreamRemote) ??
    live.find((x) => x.remote === "origin") ??
    live[0] ??
    null;
  const headRef = headEntry?.ref ?? null;
  const baseRef =
    (headRef?.parentFullName ? byFullName.get(headRef.parentFullName) : null) ?? headRef;

  res.json({
    viewer: (await github.status()).user,
    head: {
      branch,
      branches,
      repo: headRef,
      remote: headEntry?.remote ?? null,
    },
    baseCandidates: [...byFullName.values()],
    defaults: {
      baseRepo: baseRef?.fullName ?? null,
      baseBranch: baseRef?.defaultBranch ?? null,
    },
    templates,
  });
}));

api.get("/pr/branches", gh(async (req, res) => {
  requireRepoRoot(req);
  const token = await requireGitHubToken();
  const { owner, repo } = repoParam(req.query.repo);
  res.json({ branches: await github.listBranchNames(token, owner, repo) });
}));

api.get("/pr/meta", gh(async (req, res) => {
  requireRepoRoot(req);
  const token = await requireGitHubToken();
  const { owner, repo } = repoParam(req.query.repo);
  const [collaborators, assignees, labels] = await Promise.all([
    github.listCollaborators(token, owner, repo),
    github.listAssignableUsers(token, owner, repo),
    github.listLabels(token, owner, repo),
  ]);
  res.json({ collaborators, assignees, labels });
}));

api.get("/pr/template", gh(async (req, res) => {
  const root = requireRepoRoot(req);
  const path = String(req.query.path ?? "").trim();
  if (!path) {
    res.status(400).json({ error: "A template path is required" });
    return;
  }
  res.json({ body: await readPullRequestTemplate(root, path) });
}));

api.post("/pr/create", gh(async (req, res) => {
  requireRepoRoot(req);
  const token = await requireGitHubToken();
  const base = repoParam(req.body?.baseRepo);
  const head = repoParam(req.body?.headRepo);
  const baseBranch = String(req.body?.base ?? "").trim();
  const headBranch = String(req.body?.head ?? "").trim();
  const title = String(req.body?.title ?? "").trim();
  if (!title) {
    res.status(400).json({ error: "A title is required" });
    return;
  }
  if (!baseBranch || !headBranch) {
    res.status(400).json({ error: "A source and target branch are required" });
    return;
  }

  // Cross-repository (fork) pull requests identify the source as "owner:branch".
  const sameRepo =
    `${base.owner}/${base.repo}`.toLowerCase() === `${head.owner}/${head.repo}`.toLowerCase();
  const pr = await github.createPullRequest(token, {
    owner: base.owner,
    repo: base.repo,
    title,
    body: String(req.body?.body ?? ""),
    head: sameRepo ? headBranch : `${head.owner}:${headBranch}`,
    base: baseBranch,
    draft: Boolean(req.body?.draft),
  });

  // The pull request exists now — attaching people and labels is best-effort, so
  // a rejected reviewer never reads as a failed creation.
  const warnings: string[] = [];
  const reviewers = asStringArray(req.body?.reviewers);
  const assignees = asStringArray(req.body?.assignees);
  const labels = asStringArray(req.body?.labels);
  if (reviewers.length > 0) {
    try {
      await github.requestReviewers(token, base.owner, base.repo, pr.number, reviewers);
    } catch (e) {
      warnings.push(`reviewers not set (${e instanceof Error ? e.message : "failed"})`);
    }
  }
  if (assignees.length > 0 || labels.length > 0) {
    try {
      await github.updateIssueFields(token, base.owner, base.repo, pr.number, {
        ...(assignees.length > 0 ? { assignees } : {}),
        ...(labels.length > 0 ? { labels } : {}),
      });
    } catch (e) {
      warnings.push(
        `assignees/labels not set (${e instanceof Error ? e.message : "failed"})`,
      );
    }
  }

  res.json({ number: pr.number, htmlUrl: pr.htmlUrl, warnings });
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
  await forgetDeadStashNotes(root);
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
  await forgetDeadStashNotes(root);
  res.json({ stashes: await getStashes(root) });
}));

/** The title/description the user keeps on a stash, stored as a git note. */
api.post("/stash/note", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const hash = String(req.body?.hash ?? "");
  const title = String(req.body?.title ?? "");
  const description = String(req.body?.description ?? "");
  const identity = await resolveCommitIdentity();
  await setStashNote(root, hash, { title, description, identity });
  res.json({ stashes: await getStashes(root) });
}));

/**
 * Collect notes left behind by a stash that has just gone. Best-effort: losing
 * a stale note matters far less than reporting the pop or drop that succeeded.
 */
async function forgetDeadStashNotes(root: string): Promise<void> {
  try {
    await pruneStashNotes(root);
  } catch (e) {
    console.error("[gitwebui] could not prune stash notes:", e);
  }
}

// ---- Push / Pull ----

/**
 * Read the requested force mode off a push body. `"force"` means bare `--force`;
 * anything else truthy (including a legacy `true`) means `--force-with-lease`.
 */
function parseForce(raw: unknown): PushForce | undefined {
  if (raw === "force") return "force";
  return raw ? "lease" : undefined;
}

api.post("/push", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const force = parseForce(req.body?.force);
  const result = await push(root, { force });
  await refreshSession(root);
  res.json({ ...result, branches: await getBranches(root) });
}));

api.post("/pull", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const remote = String(req.body?.remote ?? "").trim();
  const branch = String(req.body?.branch ?? "").trim();
  if (Boolean(remote) !== Boolean(branch)) {
    res.status(400).json({ error: "Both a remote and branch are required for a targeted pull" });
    return;
  }
  let output = "";
  try {
    output = (await pull(root, remote && branch ? { remote, branch } : null)).output;
  } catch (e) {
    // A merge conflict from the pull isn't fatal — report it as merge state.
    if (!(await isConflicted(root))) throw e;
  }
  const repo = await refreshSession(root);
  res.json({
    repo,
    output,
    merge: await getMergeState(root),
    status: await getStatus(root),
  });
}));

// ---- Checkout a commit (detached HEAD) / cherry-pick ----

api.post("/checkout-commit", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const hash = String(req.body?.hash ?? "").trim();
  if (!hash) {
    res.status(400).json({ error: "A commit is required" });
    return;
  }
  await checkoutCommit(root, hash);
  res.json({
    repo: await refreshSession(root),
    merge: await getMergeState(root),
    status: await getStatus(root),
  });
}));

api.post("/cherry-pick", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const hash = String(req.body?.hash ?? "").trim();
  if (!hash) {
    res.status(400).json({ error: "A commit is required" });
    return;
  }
  const noCommit = Boolean(req.body?.noCommit);
  await cherryPick(root, hash, noCommit);
  res.json({
    repo: await refreshSession(root),
    merge: await getMergeState(root),
    status: await getStatus(root),
  });
}));

// ---- Merge / conflict resolution ----

api.post("/merge", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const branch = String(req.body?.branch ?? "").trim();
  const strategy = String(req.body?.strategy ?? "fast-forward");
  if (!branch) {
    res.status(400).json({ error: "A branch to merge is required" });
    return;
  }
  if (strategy !== "fast-forward" && strategy !== "merge-commit") {
    res.status(400).json({ error: "A valid merge strategy is required" });
    return;
  }
  // A conflicting merge is not an error — it's left in progress and surfaced as
  // merge state for the conflict resolver.
  await mergeBranch(root, branch, strategy);
  res.json({
    repo: await refreshSession(root),
    merge: await getMergeState(root),
    status: await getStatus(root),
  });
}));

api.get("/merge/state", h(async (req, res) => {
  const root = requireRepoRoot(req);
  res.json({ merge: await getMergeState(root) });
}));

api.get("/conflict", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const path = String(req.query.path ?? "").trim();
  if (!path) {
    res.status(400).json({ error: "A file path is required" });
    return;
  }
  res.json(await getConflictFile(root, path));
}));

api.post("/conflict/resolve", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const path = String(req.body?.path ?? "").trim();
  if (!path) {
    res.status(400).json({ error: "A file path is required" });
    return;
  }
  const content = String(req.body?.content ?? "");
  const resolved = Boolean(req.body?.resolved);
  await writeResolution(root, path, content, resolved);
  res.json({ merge: await getMergeState(root), status: await getStatus(root) });
}));

api.post("/merge/resolve-all", h(async (req, res) => {
  const root = requireRepoRoot(req);
  await markResolved(root, await conflictedPaths(root));
  res.json({ merge: await getMergeState(root), status: await getStatus(root) });
}));

api.post("/merge/abort", h(async (req, res) => {
  const root = requireRepoRoot(req);
  await abortMerge(root);
  res.json({
    repo: await refreshSession(root),
    merge: await getMergeState(root),
    status: await getStatus(root),
  });
}));

// ---- Terminal ----

api.get("/terminal/shells", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const shells = detectShells();
  res.json({ shells, cwd: root });
}));

/**
 * Run one command and stream its output as newline-delimited JSON events. The
 * response body is the stream, so the client aborting the request is what stops
 * a runaway command — no second endpoint, and no process left behind when the
 * browser goes away mid-command.
 */
api.post("/terminal/run", h(async (req, res) => {
  const root = requireRepoRoot(req);
  const command = String(req.body?.command ?? "");
  if (!command.trim()) {
    res.status(400).json({ error: "Nothing to run" });
    return;
  }
  const shell = pickShell(req.body?.shell ? String(req.body.shell) : undefined);
  const cwd = await usableCwd(String(req.body?.cwd ?? ""), root);

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // Proxies and Node's own buffering would otherwise hold output back until the
  // command finished, which is the one thing a terminal can't do.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const run = runCommand({ command, cwd, shell }, (e) => {
    if (!res.writableEnded) res.write(JSON.stringify(e) + "\n");
  });
  res.on("close", () => run.kill());
  await run.done;
  res.end();
}));

/** Fall back to the repo root if the client's directory has gone away. */
async function usableCwd(want: string, root: string): Promise<string> {
  if (!want) return root;
  try {
    if ((await fsPromises.stat(want)).isDirectory()) return want;
  } catch {
    /* gone or unreadable */
  }
  return root;
}

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
