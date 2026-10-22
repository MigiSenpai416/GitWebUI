import { promises as fsPromises } from "node:fs";
import { openRepo, createLocalRepo, currentBranch, headHash, type RepoInfo } from "./git/repo.js";
import { getLog, getMainHistory, getCommitsByHash, searchCommits } from "./git/log.js";
import { getStatus } from "./git/status.js";
import { getCommitFiles } from "./git/commitFiles.js";
import { getDiff, type DiffSource } from "./git/diff.js";
import { getBlame } from "./git/blame.js";
import { getFileHistory } from "./git/fileHistory.js";
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
import * as pullRequests from "./pullRequests.js";
import {
  githubRemotes,
  findPullRequestTemplates,
  readPullRequestTemplate,
} from "./git/pullRequest.js";
import { getIdentity, setIdentity, clearIdentity, type CommitIdentity } from "./identity.js";
import { getAiCommitInfo, setAiCommitInfo, clearAiCommitInfo, generateAiCommitInfo, parseProvider } from "./aiCommit.js";
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
import { detectShells, pickShell, runCommand, type RunEvent } from "./terminal.js";

/**
 * The operations the desktop window can ask for.
 *
 * Every call arrives from the renderer over IPC as a route name, an input
 * object and the root of the repository the calling tab has open. Nothing here
 * knows about Electron: the main process forwards each call to `dispatch()`
 * and hands back whatever it resolves to, or the message and status of
 * whatever it throws.
 *
 * Inputs come from the renderer and are validated rather than trusted, the
 * same way an HTTP body would be.
 */

export type ApiInput = Record<string, unknown>;

export interface ApiCall {
  /** Root of the repository the calling tab has open, or "" for none. */
  root: string;
  /** Aborted when the caller gives up — the long-running git reads honour it. */
  signal: AbortSignal;
  /** Streaming output for the one call that has any: `terminalRun`. */
  emit?: (event: RunEvent) => void;
}

/**
 * `read` calls never change the repository. `write` calls take the
 * repository's mutation reservation and are refused while maintenance runs on
 * it. `exclusive` calls are the maintenance — they manage the reservation
 * themselves.
 */
type Kind = "read" | "write" | "exclusive";

interface Route {
  kind: Kind;
  run: (input: ApiInput, call: ApiCall) => Promise<unknown>;
}

/** An error carrying the status the renderer is told about. */
function fail(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function read(run: Route["run"]): Route {
  return { kind: "read", run };
}

function write(run: Route["run"]): Route {
  return { kind: "write", run };
}

function exclusive(run: Route["run"]): Route {
  return { kind: "exclusive", run };
}

export const routes: Record<string, Route> = {
  currentRepo: read(async (_input, { root }) => {
    // The registry is a routing cache, not an authoritative view of Git. A
    // terminal command or another Git client can move HEAD without going through
    // one of our mutation calls, so a repository refresh must re-read both the
    // checked-out branch and its tip instead of returning the cached RepoInfo.
    return { repo: root ? await refreshSession(root) : null };
  }),

  recent: read(async () => ({ recent: await getRecent() })),

  openRepo: write(async (input) => {
    const path = String(input.path ?? "").trim();
    if (!path) throw fail(400, "A repository path is required");
    const info = registerRepo(await openRepo(path));
    await addRecent(info.root);
    return { repo: info };
  }),

  createRepo: write(async (input) => {
    const dir = String(input.dir ?? "").trim();
    const name = String(input.name ?? "").trim();
    const branch = String(input.branch ?? "").trim();
    if (!dir || !name) throw fail(400, "A parent folder and repository name are required");
    const identity = await resolveCommitIdentity();
    const info = registerRepo(await createLocalRepo(dir, name, branch, identity));
    await addRecent(info.root);
    return { repo: info };
  }),

  createGitHubRepoNew: write(async (input) => {
    const name = String(input.name ?? "").trim();
    if (!name) throw fail(400, "A repository name is required");
    const clone = Boolean(input.clone);
    const identity = await resolveCommitIdentity();
    const { created, repo } = await createGitHubRepoNew({
      name,
      description: String(input.description ?? "").trim(),
      private: Boolean(input.private),
      defaultBranch: String(input.branch ?? "").trim(),
      clone,
      dir: String(input.dir ?? "").trim(),
      identity,
    });
    if (repo) {
      registerRepo(repo);
      await addRecent(repo.root);
    }
    return { created, repo };
  }),

  cloneRepo: write(async (input) => {
    const dir = String(input.dir ?? "").trim();
    const url = String(input.url ?? "").trim();
    if (!dir || !url) throw fail(400, "A destination folder and a URL are required");
    const info = registerRepo(await cloneRepo(dir, url));
    await addRecent(info.root);
    return { repo: info };
  }),

  closeRepo: write(async (input) => {
    const root = String(input.root ?? "").trim();
    if (root) unregisterRepo(root);
    return { ok: true };
  }),

  pruneRepo: exclusive(async (_input, { root }) => {
    await pruneRepository(requireRepoRoot(root));
    return { ok: true };
  }),

  commits: read(async (input, { root: requested }) => {
    const repo = requireRepo(requested);
    const root = repo.root;
    const limit = clampInt(input.limit, 100, 1, 1000);
    const skip = clampInt(input.skip, 0, 0, Number.MAX_SAFE_INTEGER);
    if (!repo.head) return { commits: [], hasMore: false };
    // Extra branch revisions (beyond HEAD) whose commits should also appear.
    const extraRevs = asStringArray(input.revs).map((s) => s.trim()).filter(Boolean);
    const commits = await getLog(root, skip, limit + 1, ["HEAD", ...extraRevs]);
    const hasMore = commits.length > limit;
    return { commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
  }),

  mainHistory: read(async (_input, { root, signal }) => {
    return { hashes: await getMainHistory(requireRepoRoot(root), signal) };
  }),

  searchCommits: read(async (input, { root: requested, signal }) => {
    const root = requireRepoRoot(requested);
    const query = String(input.q ?? "");
    if (!query.trim() || query.length > 1000 || /[\0\r\n]/.test(query)) {
      throw fail(400, "Enter a search of 1–1000 characters on one line");
    }
    return await searchCommits(root, query, signal);
  }),

  commitsByHash: read(async (input, { root: requested, signal }) => {
    const root = requireRepoRoot(requested);
    const hashes = Array.isArray(input.hashes) ? input.hashes.map((hash) => String(hash)) : [];
    if (hashes.length === 0 || hashes.length > 80 || hashes.some((hash) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash))) {
      throw fail(400, "Expected up to 80 full commit hashes");
    }
    return { commits: await getCommitsByHash(root, hashes, signal) };
  }),

  commitFiles: read(async (input, { root, signal }) => {
    const files = await getCommitFiles(requireRepoRoot(root), String(input.hash ?? ""), signal);
    return { files };
  }),

  status: read(async (_input, { root }) => await getStatus(requireRepoRoot(root), true)),

  branches: read(async (_input, { root }) => ({ branches: await getBranches(requireRepoRoot(root)) })),

  remoteBranches: read(async (_input, { root }) => ({
    branches: await getRemoteBranches(requireRepoRoot(root)),
  })),

  checkout: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const name = String(input.branch ?? "").trim();
    if (!name) throw fail(400, "A branch name is required");
    await checkoutBranch(root, name);
    return { repo: await refreshSession(root) };
  }),

  checkoutRemote: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const remote = String(input.remote ?? "").trim();
    const local = String(input.local ?? "").trim();
    if (!remote || !local) throw fail(400, "A remote branch is required");
    await checkoutRemoteBranch(root, remote, local);
    return { repo: await refreshSession(root) };
  }),

  createBranch: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const name = String(input.name ?? "").trim();
    const hash = String(input.hash ?? "").trim();
    if (!name) throw fail(400, "A branch name is required");
    if (!hash) throw fail(400, "A commit is required");
    await createBranchAt(root, name, hash);
    return { repo: await refreshSession(root) };
  }),

  deleteBranch: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const name = String(input.name ?? "").trim();
    if (!name) throw fail(400, "A branch name is required");
    await deleteBranch(root, name);
    return { branches: await getBranches(root) };
  }),

  deleteRemoteBranch: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const remote = String(input.remote ?? "").trim();
    const branch = String(input.branch ?? "").trim();
    if (!remote || !branch) throw fail(400, "A remote and branch name are required");
    await deleteRemoteBranch(root, remote, branch);
    return { branches: await getRemoteBranches(root) };
  }),

  reset: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const hash = String(input.hash ?? "").trim();
    const mode = String(input.mode ?? "") as ResetMode;
    if (!hash) throw fail(400, "A commit is required");
    if (!["hard", "soft", "mixed"].includes(mode)) throw fail(400, "mode must be hard, soft, or mixed");
    await resetTo(root, hash, mode);
    return { repo: await refreshSession(root) };
  }),

  revert: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const hash = String(input.hash ?? "").trim();
    if (!hash) throw fail(400, "A commit is required");
    // A revert that conflicts isn't an error — it leaves the revert in progress
    // for the user to resolve, which we surface as merge state.
    try {
      await revertCommit(root, hash);
    } catch (e) {
      if (!(await isConflicted(root))) throw e;
    }
    return {
      repo: await refreshSession(root),
      merge: await getMergeState(root),
      status: await getStatus(root),
    };
  }),

  discard: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const paths = asStringArray(input.paths);
    if (paths.length > 0) {
      await discardPaths(root, paths);
    } else {
      await discardAll(root);
    }
    return await getStatus(root);
  }),

  deleteFile: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const path = String(input.path ?? "").trim();
    if (!path) throw fail(400, "A file path is required");
    await deleteFile(root, path);
    return await getStatus(root);
  }),

  // ---- File Manager / history rewrite ----

  historyFiles: read(async (input, { root }) => {
    return await getHeadFileTree(requireRepoRoot(root), input.includeHistory === true);
  }),

  historyFileContent: read(async (input, { root }) => {
    const path = String(input.path ?? "");
    const head = String(input.head ?? "");
    return await getHeadFileContent(requireRepoRoot(root), path, head);
  }),

  deleteFromHistory: exclusive(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const target = String(input.path ?? "");
    const targets = Array.isArray(input.paths)
      ? input.paths.map((item: unknown) => String(item ?? ""))
      : undefined;
    const expectedHead = String(input.expectedHead ?? "");
    const confirmation = String(input.confirmation ?? "");
    const recursive = targets ? input.recursive === true : input.recursive !== false;
    const result = await deletePathFromHistory(root, {
      path: target,
      paths: targets,
      expectedHead,
      confirmation,
      recursive,
    });
    return { ...result, repo: await refreshSession(root) };
  }),

  reveal: write(async (input, { root }) => {
    const path = String(input.path ?? "").trim();
    await revealFolder(requireRepoRoot(root), path);
    return { ok: true };
  }),

  // ---- Worktrees ----

  worktrees: read(async (_input, { root }) => ({ worktrees: await listWorktrees(requireRepoRoot(root)) })),

  addWorktree: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const path = String(input.path ?? "").trim();
    const ref = String(input.ref ?? "").trim();
    const branch = String(input.branch ?? "").trim();
    if (!path) throw fail(400, "A working directory is required");
    await addWorktree(root, { path, ref, newBranch: branch });
    return { worktrees: await listWorktrees(root) };
  }),

  removeWorktree: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const path = String(input.path ?? "").trim();
    if (!path) throw fail(400, "A worktree path is required");
    await removeWorktree(root, path);
    return { worktrees: await listWorktrees(root) };
  }),

  pruneWorktrees: write(async (_input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    await pruneWorktrees(root);
    return { worktrees: await listWorktrees(root) };
  }),

  revealWorktree: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const path = String(input.path ?? "").trim();
    // Only reveal a directory that is actually a worktree of this repo.
    const worktrees = await listWorktrees(root);
    if (!path || !worktrees.some((w) => samePath(w.path, path))) throw fail(400, "Unknown worktree");
    await openFolderAbsolute(path);
    return { ok: true };
  }),

  diff: read(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const source = String(input.source ?? "") as DiffSource;
    const path = String(input.path ?? "");
    const hash = input.hash ? String(input.hash) : undefined;
    if (!["unstaged", "staged", "commit"].includes(source) || !path) {
      throw fail(400, "source and path are required");
    }
    return await getDiff(root, source, path, hash);
  }),

  blame: read(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const path = String(input.path ?? "");
    if (!path) throw fail(400, "A file path is required");
    const revision = input.revision ? String(input.revision) : undefined;
    return await getBlame(root, path, revision);
  }),

  fileHistory: read(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const path = String(input.path ?? "");
    if (!path) throw fail(400, "A file path is required");
    const skip = clampInt(input.skip, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(input.limit, 100, 1, 200);
    const query = String(input.query ?? "");
    return await getFileHistory(root, path, skip, limit, query);
  }),

  stage: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const paths = asStringArray(input.paths);
    if (input.all) {
      await stageAll(root);
    } else {
      await stagePaths(root, paths);
    }
    return await getStatus(root);
  }),

  unstage: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const paths = asStringArray(input.paths);
    await unstagePaths(root, paths);
    return await getStatus(root);
  }),

  commit: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const title = String(input.title ?? "");
    const description = String(input.description ?? "");
    const amend = Boolean(input.amend);
    const identity = await resolveCommitIdentity();
    const hash = await commit(root, { title, description, amend, identity });
    // A first commit moves an unborn repository from head=null to a real HEAD;
    // amend moves HEAD as well. Keep the registry authoritative before the client
    // reloads the commits, whose unborn-repo fast path reads this metadata.
    const [status, repo] = await Promise.all([getStatus(root), refreshSession(root, hash)]);
    return { hash, status, repo };
  }),

  // ---- AI commit information ----

  aiCommitInfo: read(async () => await getAiCommitInfo()),

  setAiCommitInfo: write(async (input) => {
    const apiKey = String(input.apiKey ?? "");
    const model = String(input.model ?? "");
    const provider = parseProvider(input.provider);
    const baseUrl = String(input.baseUrl ?? "");
    return await setAiCommitInfo(apiKey, model, provider, baseUrl);
  }),

  clearAiCommitInfo: write(async (input) => {
    const provider = input.provider === undefined ? undefined : parseProvider(input.provider);
    return await clearAiCommitInfo(provider);
  }),

  generateAiCommitInfo: write(async (input, { root, signal }) => {
    return await generateAiCommitInfo(requireRepoRoot(root), Boolean(input.amend), signal);
  }),

  // ---- Commit identity ----

  identity: read(async () => {
    const [manual, gh] = await Promise.all([getIdentity(), github.githubIdentity()]);
    return { manual, github: gh, effective: gh ?? manual ?? null };
  }),

  setIdentity: write(async (input) => {
    const name = String(input.name ?? "");
    const email = String(input.email ?? "");
    const manual = await setIdentity(name, email);
    const gh = await github.githubIdentity();
    return { manual, github: gh, effective: gh ?? manual };
  }),

  clearIdentity: write(async () => {
    await clearIdentity();
    const gh = await github.githubIdentity();
    return { manual: null, github: gh, effective: gh ?? null };
  }),

  // ---- GitHub account (OAuth or Personal Access Token) ----

  githubStatus: read(async () => await github.status()),

  githubSetToken: write(async (input) => {
    const token = String(input.token ?? "").trim();
    if (!token) throw fail(400, "A token is required");
    // Validate the token against the GitHub API before storing it.
    const user = await github.fetchUser(token);
    await github.setToken(token, { authMethod: "pat" });
    return { configured: true, authMethod: "pat", user };
  }),

  githubRevoke: write(async () => {
    await github.deleteToken();
    return { configured: false, authMethod: null, user: null };
  }),

  githubOAuthStart: write(async () => await github.beginOAuthDeviceFlow()),

  githubOAuthPoll: write(async (input) => {
    const flowId = String(input.flowId ?? "").trim();
    if (!flowId) throw fail(400, "An OAuth flow is required");
    return await github.pollOAuthDeviceFlow(flowId);
  }),

  githubOAuthCancel: write(async (input) => {
    const flowId = String(input.flowId ?? "").trim();
    if (flowId) await github.cancelOAuthDeviceFlow(flowId);
    return { ok: true };
  }),

  githubRepos: read(async () => {
    const token = await github.getToken();
    if (!token) throw fail(401, "Connect a GitHub account first");
    return { repos: await github.listRepos(token) };
  }),

  // ---- Pull requests (GitHub) ----

  prList: gh("read", async (input, { root }) => {
    const { slug, page } = prTarget(input, root);
    const state = String(input.state ?? "open");
    if (!["open", "closed", "all"].includes(state)) throw fail(400, "Invalid pull request state");
    return await pullRequests.listPullRequests(await requireGitHubToken(), slug, state, page);
  }),

  prDetails: gh("read", async (input, { root }) => {
    const { slug, number } = prTarget(input, root);
    requirePrNumber(number);
    return await pullRequests.pullRequestDetails(await requireGitHubToken(), slug, number);
  }),

  prActivity: gh("read", async (input, { root }) => {
    const { slug, number, page } = prTarget(input, root);
    requirePrNumber(number);
    return await pullRequests.pullRequestActivity(await requireGitHubToken(), slug, number, String(input.kind), page);
  }),

  prChecks: gh("read", async (input, { root }) => {
    const { slug, number, page } = prTarget(input, root);
    requirePrNumber(number);
    return await pullRequests.pullRequestChecks(await requireGitHubToken(), slug, number, page);
  }),

  prAction: gh("write", async (input, { root }) => {
    const { slug, number } = prTarget(input, root);
    requirePrNumber(number);
    return await pullRequests.actOnPullRequest(await requireGitHubToken(), slug, number, input);
  }),

  prContext: gh("read", async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const token = await requireGitHubToken();
    const [branches, templates, branch] = await Promise.all([
      getBranches(root),
      findPullRequestTemplates(root),
      currentBranch(root),
    ]);
    const selectedBranch = typeof input.branch === "string" && input.branch ? input.branch : branch;
    const upstreamRemote = branches.find((b) => b.name === selectedBranch)?.upstream?.split("/")[0] ?? null;
    const remotes = await githubRemotes(root, upstreamRemote);

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
    const headEntry =
      live.find((x) => x.remote === upstreamRemote) ??
      live.find((x) => x.remote === "origin") ??
      live[0] ??
      null;
    const headRef = headEntry?.ref ?? null;
    const baseRef =
      (headRef?.parentFullName ? byFullName.get(headRef.parentFullName) : null) ?? headRef;

    return {
      viewer: (await github.status()).user,
      head: {
        branch: selectedBranch,
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
    };
  }),

  prBranches: gh("read", async (input, { root }) => {
    requireRepoRoot(root);
    const token = await requireGitHubToken();
    const { owner, repo } = repoParam(input.repo);
    return { branches: await github.listBranchNames(token, owner, repo) };
  }),

  prMeta: gh("read", async (input, { root }) => {
    requireRepoRoot(root);
    const token = await requireGitHubToken();
    const { owner, repo } = repoParam(input.repo);
    const [collaborators, assignees, labels] = await Promise.all([
      github.listCollaborators(token, owner, repo),
      github.listAssignableUsers(token, owner, repo),
      github.listLabels(token, owner, repo),
    ]);
    return { collaborators, assignees, labels };
  }),

  prTemplate: gh("read", async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const path = String(input.path ?? "").trim();
    if (!path) throw fail(400, "A template path is required");
    return { body: await readPullRequestTemplate(root, path) };
  }),

  prCreate: gh("write", async (input, { root }) => {
    requireRepoRoot(root);
    const token = await requireGitHubToken();
    const base = repoParam(input.baseRepo);
    const head = repoParam(input.headRepo);
    const baseBranch = String(input.base ?? "").trim();
    const headBranch = String(input.head ?? "").trim();
    const title = String(input.title ?? "").trim();
    if (!title) throw fail(400, "A title is required");
    if (!baseBranch || !headBranch) throw fail(400, "A source and target branch are required");

    // Cross-repository (fork) pull requests identify the source as "owner:branch".
    const sameRepo =
      `${base.owner}/${base.repo}`.toLowerCase() === `${head.owner}/${head.repo}`.toLowerCase();
    const pr = await github.createPullRequest(token, {
      owner: base.owner,
      repo: base.repo,
      title,
      body: String(input.body ?? ""),
      head: sameRepo ? headBranch : `${head.owner}:${headBranch}`,
      ...(!sameRepo ? { headRepo: head.repo } : {}),
      base: baseBranch,
      draft: Boolean(input.draft),
    });

    // The pull request exists now — attaching people and labels is best-effort, so
    // a rejected reviewer never reads as a failed creation.
    const warnings: string[] = [];
    const reviewers = asStringArray(input.reviewers);
    const assignees = asStringArray(input.assignees);
    const labels = asStringArray(input.labels);
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

    return { number: pr.number, htmlUrl: pr.htmlUrl, warnings };
  }),

  // ---- Remotes ----

  remotes: read(async (_input, { root }) => ({ remotes: await getRemotes(requireRepoRoot(root)) })),

  addRemote: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const name = String(input.name ?? "").trim();
    const url = String(input.url ?? "").trim();
    if (!name || !url) throw fail(400, "A remote name and URL are required");
    const existing = await getRemotes(root);
    if (existing.some((r) => r.name === name)) {
      await setRemoteUrl(root, name, url);
    } else {
      await addRemote(root, name, url);
    }
    return { remotes: await getRemotes(root) };
  }),

  removeRemote: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const name = String(input.name ?? "").trim();
    if (!name) throw fail(400, "A remote name is required");
    await removeRemote(root, name);
    return { remotes: await getRemotes(root) };
  }),

  createGitHubRepo: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const name = String(input.name ?? "").trim();
    if (!name) throw fail(400, "A repository name is required");
    const result = await createGitHubRemote(root, {
      name,
      description: String(input.description ?? "").trim(),
      private: Boolean(input.private),
      remoteName: String(input.remoteName ?? "origin").trim() || "origin",
    });
    await refreshSession(root);
    return result;
  }),

  // ---- Stash ----

  stashes: read(async (_input, { root }) => ({ stashes: await getStashes(requireRepoRoot(root)) })),

  stashPush: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const message = String(input.message ?? "");
    const result = await stashPush(root, { message });
    return { ...result, status: await getStatus(root), stashes: await getStashes(root) };
  }),

  stashPop: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const index = clampInt(input.index, 0, 0, Number.MAX_SAFE_INTEGER);
    const result = await stashPop(root, index);
    await forgetDeadStashNotes(root);
    return { ...result, status: await getStatus(root), stashes: await getStashes(root) };
  }),

  stashApply: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const index = clampInt(input.index, 0, 0, Number.MAX_SAFE_INTEGER);
    const result = await stashApply(root, index);
    return { ...result, status: await getStatus(root), stashes: await getStashes(root) };
  }),

  stashDrop: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const index = clampInt(input.index, 0, 0, Number.MAX_SAFE_INTEGER);
    await stashDrop(root, index);
    await forgetDeadStashNotes(root);
    return { stashes: await getStashes(root) };
  }),

  /** The title/description the user keeps on a stash, stored as a git note. */
  stashNote: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const hash = String(input.hash ?? "");
    const title = String(input.title ?? "");
    const description = String(input.description ?? "");
    const identity = await resolveCommitIdentity();
    await setStashNote(root, hash, { title, description, identity });
    return { stashes: await getStashes(root) };
  }),

  // ---- Push / Pull ----

  push: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const force = parseForce(input.force);
    const result = await push(root, { force });
    await refreshSession(root);
    return { ...result, branches: await getBranches(root) };
  }),

  pull: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const remote = String(input.remote ?? "").trim();
    const branch = String(input.branch ?? "").trim();
    if (Boolean(remote) !== Boolean(branch)) {
      throw fail(400, "Both a remote and branch are required for a targeted pull");
    }
    let output = "";
    try {
      output = (await pull(root, remote && branch ? { remote, branch } : null)).output;
    } catch (e) {
      // A merge conflict from the pull isn't fatal — report it as merge state.
      if (!(await isConflicted(root))) throw e;
    }
    const repo = await refreshSession(root);
    return {
      repo,
      output,
      merge: await getMergeState(root),
      status: await getStatus(root),
    };
  }),

  // ---- Checkout a commit (detached HEAD) / cherry-pick ----

  checkoutCommit: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const hash = String(input.hash ?? "").trim();
    if (!hash) throw fail(400, "A commit is required");
    await checkoutCommit(root, hash);
    return {
      repo: await refreshSession(root),
      merge: await getMergeState(root),
      status: await getStatus(root),
    };
  }),

  cherryPick: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const hash = String(input.hash ?? "").trim();
    if (!hash) throw fail(400, "A commit is required");
    const noCommit = Boolean(input.noCommit);
    await cherryPick(root, hash, noCommit);
    return {
      repo: await refreshSession(root),
      merge: await getMergeState(root),
      status: await getStatus(root),
    };
  }),

  // ---- Merge / conflict resolution ----

  merge: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const branch = String(input.branch ?? "").trim();
    const strategy = String(input.strategy ?? "fast-forward");
    if (!branch) throw fail(400, "A branch to merge is required");
    if (strategy !== "fast-forward" && strategy !== "merge-commit") {
      throw fail(400, "A valid merge strategy is required");
    }
    // A conflicting merge is not an error — it's left in progress and surfaced as
    // merge state for the conflict resolver.
    await mergeBranch(root, branch, strategy);
    return {
      repo: await refreshSession(root),
      merge: await getMergeState(root),
      status: await getStatus(root),
    };
  }),

  mergeState: read(async (_input, { root }) => ({ merge: await getMergeState(requireRepoRoot(root)) })),

  conflictFile: read(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const path = String(input.path ?? "").trim();
    if (!path) throw fail(400, "A file path is required");
    return await getConflictFile(root, path);
  }),

  resolveConflict: write(async (input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    const path = String(input.path ?? "").trim();
    if (!path) throw fail(400, "A file path is required");
    const content = String(input.content ?? "");
    const resolved = Boolean(input.resolved);
    await writeResolution(root, path, content, resolved);
    return { merge: await getMergeState(root), status: await getStatus(root) };
  }),

  resolveAll: write(async (_input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    await markResolved(root, await conflictedPaths(root));
    return { merge: await getMergeState(root), status: await getStatus(root) };
  }),

  abortMerge: write(async (_input, { root: requested }) => {
    const root = requireRepoRoot(requested);
    await abortMerge(root);
    return {
      repo: await refreshSession(root),
      merge: await getMergeState(root),
      status: await getStatus(root),
    };
  }),

  // ---- Terminal ----

  terminalShells: read(async (_input, { root }) => {
    const cwd = requireRepoRoot(root);
    return { shells: detectShells(), cwd };
  }),

  /**
   * Run one command, streaming its output through `emit`. The call resolves
   * once the command is over; aborting it is what stops a runaway command, and
   * the window going away aborts it too, so nothing is left running behind it.
   */
  terminalRun: write(async (input, { root: requested, signal, emit }) => {
    const root = requireRepoRoot(requested);
    const command = String(input.command ?? "");
    if (!command.trim()) throw fail(400, "Nothing to run");
    const shell = pickShell(input.shell ? String(input.shell) : undefined);
    const cwd = await usableCwd(String(input.cwd ?? ""), root);

    const run = runCommand({ command, cwd, shell }, (e) => emit?.(e));
    const kill = () => run.kill();
    if (signal.aborted) kill();
    signal.addEventListener("abort", kill, { once: true });
    try {
      await run.done;
    } finally {
      signal.removeEventListener("abort", kill);
    }
    return { ok: true };
  }),
};

/**
 * Run one call.
 *
 * A call that names a repository the registry doesn't know yet (a tab restored
 * from the previous session) has it re-validated and registered first, so it
 * works without an explicit re-open round-trip.
 *
 * History rewriting temporarily replaces every ref, so every other call that
 * changes something — terminal commands included — is kept out of that window:
 * refused while it runs, and reserved synchronously before the handler's first
 * await, which closes the gap where an admitted call could start mutating after
 * a rewrite had already passed its preflight.
 */
export async function dispatch(name: string, input: unknown, call: ApiCall): Promise<unknown> {
  const route = Object.hasOwn(routes, name) ? routes[name] : undefined;
  if (!route) throw fail(404, `Unknown operation: ${name}`);
  const args: ApiInput =
    input !== null && typeof input === "object" && !Array.isArray(input) ? (input as ApiInput) : {};
  const root = call.root.trim();

  if (root && !getRepoByRoot(root)) {
    try {
      registerRepo(await openRepo(root));
    } catch {
      // Left unregistered, so requireRepo reports a clean 409.
    }
  }

  let release: (() => void) | null = null;
  if (root && route.kind === "write") {
    if (isRepoMaintenanceActive(root)) {
      throw fail(409, "Repository maintenance is running for this repository");
    }
    release = beginRepoMutation(root);
  }
  try {
    return await route.run(args, { ...call, root });
  } finally {
    release?.();
  }
}

/** The status to report for an error a call threw. */
export function errorStatus(err: unknown): number {
  return (err as { status?: number }).status ?? (err instanceof GitError ? 422 : 500);
}

/** The message to report for an error a call threw. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Internal error";
}

// ---- Commit identity ----

/** Effective commit identity: the connected GitHub account, else the manual one. */
async function resolveCommitIdentity(): Promise<CommitIdentity | null> {
  return (await github.githubIdentity()) ?? (await getIdentity());
}

// ---- Pull requests (GitHub) ----

/** How many GitHub remotes we resolve against the API when opening the dialog. */
const MAX_PR_REPOS = 5;

/**
 * Wrap a pull-request call so a rejected GitHub token surfaces as 403 with a
 * way forward. A 401 for the token the call used is rotated once and the user
 * asked to retry; anything else asks for a reconnect.
 */
function gh(kind: Kind, run: Route["run"]): Route {
  return {
    kind,
    run: async (input, call) => {
      const token = await github.getToken();
      try {
        return await run(input, call);
      } catch (e) {
        if ((e as { status?: number }).status !== 401) throw e;
        const message = e instanceof Error ? e.message : "GitHub authentication failed";
        if ((e as { githubStatus?: number }).githubStatus === 401) {
          if (token && (await github.refreshRejectedToken(token))) {
            throw fail(403, `${message} — the GitHub token has been refreshed; try again.`);
          }
        }
        throw fail(403, `${message} — reconnect your GitHub account in Actions → GitHub.`);
      }
    },
  };
}

async function requireGitHubToken(): Promise<string> {
  const token = await github.getToken();
  if (!token) throw fail(403, "Connect a GitHub account first");
  return token;
}

/** Parse an "owner/name" input. */
function repoParam(v: unknown): { owner: string; repo: string } {
  const [owner, repo] = String(v ?? "").trim().split("/");
  if (!owner || !repo) throw fail(400, "A repository (owner/name) is required");
  return { owner, repo };
}

function prTarget(input: ApiInput, root: string) {
  requireRepoRoot(root);
  const slug = String(input.repo ?? "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || slug.split("/").some((s) => s === "." || s === "..")) {
    throw fail(400, "A valid repository (owner/name) is required");
  }
  const number = Number(input.number);
  const page = Number(input.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw fail(400, "Invalid page");
  return { slug, number, page };
}

function requirePrNumber(number: number) {
  if (!Number.isSafeInteger(number) || number < 1) throw fail(400, "Invalid pull request number");
}

// ---- Stash ----

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
 * Read the requested force mode off a push. `"force"` means bare `--force`;
 * anything else truthy (including a legacy `true`) means `--force-with-lease`.
 */
function parseForce(raw: unknown): PushForce | undefined {
  if (raw === "force") return "force";
  return raw ? "lease" : undefined;
}

// ---- Terminal ----

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
async function refreshSession(root: string, head?: string): Promise<RepoInfo | null> {
  const info = getRepoByRoot(root);
  if (!info) return null;
  const [branch, hash] = await Promise.all([currentBranch(root), head ?? headHash(root)]);
  info.branch = branch;
  info.head = hash;
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
