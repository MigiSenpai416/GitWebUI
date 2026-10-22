import type {
  AiCommitInfo,
  AiCommitMessage,
  AiCommitProvider,
  BlameResult,
  Branch,
  Commit,
  CommitFile,
  ConflictFileData,
  CreatePrInput,
  CreatedPr,
  DiffResult,
  DiffSource,
  FileHistoryResult,
  GitHubOAuthDeviceFlow,
  GitHubOAuthPoll,
  GitHubRepo,
  GitHubStatus,
  GitHubUser,
  HeadFileContent,
  HeadFileTree,
  HistoryDeleteResult,
  IdentityInfo,
  MergeState,
  MergeStrategy,
  PrContext,
  PrMeta,
  PullRequestSummary,
  PullRequestDetails,
  PrActivity,
  PrChecks,
  PushForce,
  RepoInfo,
  Remote,
  RemoteBranch,
  StashEntry,
  StatusResult,
  Worktree,
} from "../types";
import { desktop, type ApiReply, type RunEvent } from "../desktop";

export type { RunEvent };

/**
 * Root of the repo the current tab targets. Sent with every call so the core
 * knows which of the open repos to act on. The store updates this whenever the
 * active tab changes.
 */
let activeRepoRoot: string | null = null;
export function setRequestRepoRoot(root: string | null): void {
  activeRepoRoot = root;
}

let lastCallId = 0;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Make one call into the core over the desktop bridge.
 *
 * Behaves the way the `fetch` it replaced did: a failed call rejects with the
 * core's message, and aborting `signal` rejects at once with an `AbortError`
 * while the core is told to stop working on it.
 */
function send(
  route: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onStart?: (id: number) => void,
): Promise<ApiReply> {
  if (signal?.aborted) return Promise.reject(abortError());
  const bridge = desktop();
  const id = ++lastCallId;
  onStart?.(id);
  const reply = bridge.call(id, route, input, activeRepoRoot);
  if (!signal) return reply;
  return new Promise<ApiReply>((resolve, reject) => {
    const onAbort = () => {
      bridge.cancel(id);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reply.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function unwrap<T>(reply: ApiReply): T {
  if (!reply.ok) throw new Error(reply.error || `Request failed (${reply.status})`);
  return JSON.parse(reply.json) as T;
}

async function req<T>(
  route: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  return unwrap<T>(await send(route, input, signal));
}

export interface ShellInfo {
  id: string;
  label: string;
  path: string;
  kind: "bash" | "zsh" | "sh" | "powershell" | "pwsh";
}

/**
 * How long to wait for a command's exit event after the call itself has
 * settled. Events and the reply travel separately, so the reply can overtake
 * the last of the output; this is the bound on waiting for it to catch up.
 */
const EXIT_EVENT_GRACE_MS = 1_000;

/**
 * Run a command, handing each chunk to `onEvent` as it arrives rather than
 * waiting for it to finish. Aborting `signal` is what stops the command.
 */
export async function runTerminalCommand(
  body: { command: string; cwd: string; shell: string },
  onEvent: (e: RunEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let callId: number | null = null;
  let exited = false;
  let notifyExit = () => {};
  const exitSeen = new Promise<void>((resolve) => {
    notifyExit = resolve;
  });
  const unsubscribe = desktop().onTerminalEvent((id, event) => {
    if (id !== callId || exited) return;
    if (event.t === "exit") {
      exited = true;
      notifyExit();
    }
    onEvent(event);
  });
  try {
    const reply = await send("terminalRun", body, signal, (id) => {
      callId = id;
    });
    unwrap<unknown>(reply);
    if (!exited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exitSeen,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, EXIT_EVENT_GRACE_MS);
        }),
      ]);
      clearTimeout(timer);
    }
  } finally {
    unsubscribe();
  }
}

export const api = {
  currentRepo: () => req<{ repo: RepoInfo | null }>("currentRepo"),
  recent: () => req<{ recent: string[] }>("recent"),
  openRepo: (path: string) => req<{ repo: RepoInfo }>("openRepo", { path }),
  cloneRepo: (dir: string, url: string) => req<{ repo: RepoInfo }>("cloneRepo", { dir, url }),
  createRepo: (dir: string, name: string, branch: string) =>
    req<{ repo: RepoInfo }>("createRepo", { dir, name, branch }),
  createGitHubRepoNew: (opts: {
    name: string;
    description: string;
    private: boolean;
    branch: string;
    clone: boolean;
    dir: string;
  }) =>
    req<{
      created: { fullName: string; cloneUrl: string; htmlUrl: string };
      repo: RepoInfo | null;
    }>("createGitHubRepoNew", opts),
  closeRepo: (root: string) => req<{ ok: true }>("closeRepo", { root }),

  commits: (skip: number, limit: number, revs: string[] = []) =>
    req<{ commits: Commit[]; hasMore: boolean }>("commits", { skip, limit, revs }),
  commitFiles: (hash: string, signal?: AbortSignal) =>
    req<{ files: CommitFile[] }>("commitFiles", { hash }, signal),
  mainHistory: (signal?: AbortSignal) => req<{ hashes: string[] }>("mainHistory", {}, signal),
  searchCommits: (query: string, signal?: AbortSignal) =>
    req<{ rows: Pick<Commit, "hash" | "parents">[]; matches: number[] }>(
      "searchCommits", { q: query }, signal,
    ),
  commitsByHash: (hashes: string[], signal?: AbortSignal) =>
    req<{ commits: Commit[] }>("commitsByHash", { hashes }, signal),

  status: () => req<StatusResult>("status"),

  branches: () => req<{ branches: Branch[] }>("branches"),
  remoteBranches: () => req<{ branches: RemoteBranch[] }>("remoteBranches"),

  worktrees: () => req<{ worktrees: Worktree[] }>("worktrees"),
  addWorktree: (path: string, ref: string, branch: string) =>
    req<{ worktrees: Worktree[] }>("addWorktree", { path, ref, branch }),
  removeWorktree: (path: string) => req<{ worktrees: Worktree[] }>("removeWorktree", { path }),
  pruneWorktrees: () => req<{ worktrees: Worktree[] }>("pruneWorktrees"),
  revealWorktree: (path: string) => req<{ ok: true }>("revealWorktree", { path }),
  checkout: (branch: string) => req<{ repo: RepoInfo }>("checkout", { branch }),
  checkoutRemote: (remote: string, local: string) =>
    req<{ repo: RepoInfo }>("checkoutRemote", { remote, local }),
  createBranch: (name: string, hash: string) => req<{ repo: RepoInfo }>("createBranch", { name, hash }),
  deleteBranch: (name: string) => req<{ branches: Branch[] }>("deleteBranch", { name }),
  deleteRemoteBranch: (remote: string, branch: string) =>
    req<{ branches: RemoteBranch[] }>("deleteRemoteBranch", { remote, branch }),
  reset: (hash: string, mode: "hard" | "soft" | "mixed") =>
    req<{ repo: RepoInfo }>("reset", { hash, mode }),
  revert: (hash: string) =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("revert", { hash }),
  discardAll: () => req<StatusResult>("discard"),
  discardPaths: (paths: string[]) => req<StatusResult>("discard", { paths }),
  deleteFile: (path: string) => req<StatusResult>("deleteFile", { path }),
  historyFiles: (includeHistory = false) => req<HeadFileTree>("historyFiles", { includeHistory }),
  historyFileContent: (path: string, head: string) =>
    req<HeadFileContent>("historyFileContent", { path, head }),
  deleteFromHistory: (paths: string[], expectedHead: string, confirmation: string, recursive: boolean) =>
    req<HistoryDeleteResult>("deleteFromHistory", { paths, expectedHead, confirmation, recursive }),
  pruneRepo: () => req<{ ok: true }>("pruneRepo"),
  reveal: (path: string) => req<{ ok: true }>("reveal", { path }),

  diff: (source: DiffSource, path: string, hash?: string) =>
    req<DiffResult>("diff", { source, path, hash }),
  blame: (path: string, revision?: string) => req<BlameResult>("blame", { path, revision }),
  fileHistory: (path: string, skip: number, limit: number, query = "") =>
    req<FileHistoryResult>("fileHistory", { path, skip, limit, query }),

  stage: (paths: string[]) => req<StatusResult>("stage", { paths }),
  stageAll: () => req<StatusResult>("stage", { all: true }),
  unstage: (paths: string[]) => req<StatusResult>("unstage", { paths }),
  commit: (title: string, description: string, amend: boolean) =>
    req<{ hash: string; status: StatusResult; repo: RepoInfo | null }>("commit", { title, description, amend }),

  // AI commit information
  aiCommitInfo: (signal?: AbortSignal) => req<AiCommitInfo>("aiCommitInfo", {}, signal),
  setAiCommitInfo: (apiKey: string, model: string, provider: AiCommitProvider, baseUrl: string) =>
    req<AiCommitInfo>("setAiCommitInfo", { apiKey, model, provider, baseUrl }),
  clearAiCommitInfo: (provider: AiCommitProvider) => req<AiCommitInfo>("clearAiCommitInfo", { provider }),
  generateAiCommitInfo: (amend: boolean, signal: AbortSignal) =>
    req<AiCommitMessage>("generateAiCommitInfo", { amend }, signal),

  // Commit identity
  identity: () => req<IdentityInfo>("identity"),
  setIdentity: (name: string, email: string) => req<IdentityInfo>("setIdentity", { name, email }),
  clearIdentity: () => req<IdentityInfo>("clearIdentity"),

  // GitHub account (OAuth or Personal Access Token)
  githubStatus: () => req<GitHubStatus>("githubStatus"),
  githubSetToken: (token: string) =>
    req<{ configured: true; authMethod: "pat"; user: GitHubUser }>("githubSetToken", { token }),
  githubRevoke: () => req<{ configured: false; authMethod: null; user: null }>("githubRevoke"),
  githubOAuthStart: () => req<GitHubOAuthDeviceFlow>("githubOAuthStart"),
  githubOAuthPoll: (flowId: string) => req<GitHubOAuthPoll>("githubOAuthPoll", { flowId }),
  githubOAuthCancel: (flowId: string) => req<{ ok: true }>("githubOAuthCancel", { flowId }),
  githubRepos: () => req<{ repos: GitHubRepo[] }>("githubRepos"),

  // Remotes
  remotes: () => req<{ remotes: Remote[] }>("remotes"),
  addRemote: (name: string, url: string) => req<{ remotes: Remote[] }>("addRemote", { name, url }),
  removeRemote: (name: string) => req<{ remotes: Remote[] }>("removeRemote", { name }),
  createGitHubRepo: (opts: {
    name: string;
    description: string;
    private: boolean;
    remoteName: string;
  }) =>
    req<{ repo: { fullName: string; cloneUrl: string; htmlUrl: string }; remotes: Remote[] }>(
      "createGitHubRepo",
      opts,
    ),

  // Pull requests (GitHub)
  prContext: (signal?: AbortSignal, branch?: string) => req<PrContext>("prContext", { branch }, signal),
  prList: (repo: string, state: string, page: number, signal?: AbortSignal) =>
    req<{ items: PullRequestSummary[]; hasMore: boolean }>("prList", { repo, state, page }, signal),
  prDetails: (repo: string, number: number, signal?: AbortSignal) =>
    req<PullRequestDetails>("prDetails", { repo, number }, signal),
  prActivity: (repo: string, number: number, kind: string, page: number, signal?: AbortSignal) =>
    req<{ items: PrActivity[]; hasMore: boolean; sha?: string; warning?: string }>(
      "prActivity", { repo, number, kind, page }, signal,
    ),
  prChecks: (repo: string, number: number, page: number, signal?: AbortSignal) =>
    req<PrChecks>("prChecks", { repo, number, page }, signal),
  prAction: (repo: string, number: number, input: Record<string, unknown>) =>
    req<{ ok: boolean }>("prAction", { ...input, repo, number }),
  prReply: (repo: string, number: number, commentId: number, body: string) =>
    req<{ ok: boolean; reply: PrActivity }>("prAction", { action: "reply", repo, number, commentId, body }),
  prBranches: (repo: string) => req<{ branches: string[] }>("prBranches", { repo }),
  prMeta: (repo: string) => req<PrMeta>("prMeta", { repo }),
  prTemplate: (path: string) => req<{ body: string }>("prTemplate", { path }),
  prCreate: (input: CreatePrInput) => req<CreatedPr>("prCreate", { ...input }),

  // Push / Pull
  push: (force: PushForce | null = null) =>
    req<{
      branch: string;
      output: string;
      rejected?: boolean;
      upstream?: string | null;
      remote?: string;
      remoteBranch?: string;
      branches: Branch[];
    }>("push", { force: force ?? false }),
  pull: (remote?: string, branch?: string) =>
    req<{ repo: RepoInfo | null; output: string; merge: MergeState; status: StatusResult }>(
      "pull", { remote, branch },
    ),

  // Checkout a commit (detached HEAD) / cherry-pick
  checkoutCommit: (hash: string) =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("checkoutCommit", { hash }),
  cherryPick: (hash: string, noCommit: boolean) =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("cherryPick", { hash, noCommit }),

  // Merge / conflict resolution
  merge: (branch: string, strategy: MergeStrategy) =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("merge", { branch, strategy }),
  mergeState: () => req<{ merge: MergeState }>("mergeState"),
  conflictFile: (path: string) => req<ConflictFileData>("conflictFile", { path }),
  resolveConflict: (path: string, content: string, resolved: boolean) =>
    req<{ merge: MergeState; status: StatusResult }>("resolveConflict", { path, content, resolved }),
  resolveAll: () => req<{ merge: MergeState; status: StatusResult }>("resolveAll"),
  abortMerge: () =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("abortMerge"),

  // Stash
  stashes: () => req<{ stashes: StashEntry[] }>("stashes"),
  stashPush: () =>
    req<{ stashed: boolean; output: string; status: StatusResult; stashes: StashEntry[] }>("stashPush"),
  stashPop: (index: number) =>
    req<{ output: string; status: StatusResult; stashes: StashEntry[] }>("stashPop", { index }),
  stashApply: (index: number) =>
    req<{ output: string; status: StatusResult; stashes: StashEntry[] }>("stashApply", { index }),
  stashDrop: (index: number) => req<{ stashes: StashEntry[] }>("stashDrop", { index }),
  terminalShells: () => req<{ shells: ShellInfo[]; cwd: string }>("terminalShells"),
  stashNote: (hash: string, title: string, description: string) =>
    req<{ stashes: StashEntry[] }>("stashNote", { hash, title, description }),
};
