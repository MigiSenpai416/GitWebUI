import type {
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
  PushForce,
  RepoInfo,
  Remote,
  RemoteBranch,
  StashEntry,
  StatusResult,
  Worktree,
} from "../types";

/** Thrown on a 401 so the store can drop back to the login screen. */
export class AuthError extends Error {}

/**
 * Root of the repo the current tab targets. Sent as `X-Repo-Root` on every
 * request so the server knows which of the open repos to act on. The store
 * updates this whenever the active tab changes.
 */
let activeRepoRoot: string | null = null;
export function setRequestRepoRoot(root: string | null): void {
  activeRepoRoot = root;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (activeRepoRoot) headers["X-Repo-Root"] = activeRepoRoot;
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401) throw new AuthError(message);
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}

export interface ShellInfo {
  id: string;
  label: string;
  path: string;
  kind: "bash" | "zsh" | "sh" | "powershell" | "pwsh";
}

/** One line of the terminal's output stream. */
export interface RunEvent {
  t: "out" | "err" | "exit";
  d?: string;
  code?: number | null;
  cwd?: string;
  killed?: boolean;
}

/**
 * Run a command, handing each chunk to `onEvent` as it arrives rather than
 * waiting for the whole response. Aborting `signal` closes the request, which
 * is what stops the command server-side.
 */
export async function runTerminalCommand(
  body: { command: string; cwd: string; shell: string },
  onEvent: (e: RunEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (activeRepoRoot) headers["X-Repo-Root"] = activeRepoRoot;
  const res = await fetch("/api/terminal/run", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const parsed = await res.json();
      if (parsed?.error) message = parsed.error;
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401) throw new AuthError(message);
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Events are newline-delimited JSON; a chunk can split one in half.
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) onEvent(JSON.parse(line) as RunEvent);
    }
  }
}

export const api = {
  authStatus: () => req<AuthStatus>("/api/auth/status"),
  authSetup: (password: string, remember: boolean) =>
    req<{ ok: true }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password, remember }),
    }),
  authLogin: (password: string, remember: boolean) =>
    req<{ ok: true }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password, remember }),
    }),
  authLogout: () => req<{ ok: true }>("/api/auth/logout", { method: "POST", body: "{}" }),

  currentRepo: () => req<{ repo: RepoInfo | null }>("/api/repo/current"),
  recent: () => req<{ recent: string[] }>("/api/repo/recent"),
  openRepo: (path: string) =>
    req<{ repo: RepoInfo }>("/api/repo/open", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  cloneRepo: (dir: string, url: string) =>
    req<{ repo: RepoInfo }>("/api/repo/clone", {
      method: "POST",
      body: JSON.stringify({ dir, url }),
    }),
  createRepo: (dir: string, name: string, branch: string) =>
    req<{ repo: RepoInfo }>("/api/repo/create", {
      method: "POST",
      body: JSON.stringify({ dir, name, branch }),
    }),
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
    }>("/api/repo/create-github", { method: "POST", body: JSON.stringify(opts) }),
  closeRepo: (root: string) =>
    req<{ ok: true }>("/api/repo/close", {
      method: "POST",
      body: JSON.stringify({ root }),
    }),

  commits: (skip: number, limit: number, revs: string[] = []) => {
    const params = new URLSearchParams({ skip: String(skip), limit: String(limit) });
    if (revs.length > 0) params.set("revs", revs.join(","));
    return req<{ commits: Commit[]; hasMore: boolean }>(`/api/commits?${params.toString()}`);
  },
  commitFiles: (hash: string) =>
    req<{ files: CommitFile[] }>(`/api/commits/${hash}/files`),

  status: () => req<StatusResult>("/api/status"),

  branches: () => req<{ branches: Branch[] }>("/api/branches"),
  remoteBranches: () => req<{ branches: RemoteBranch[] }>("/api/remote-branches"),

  worktrees: () => req<{ worktrees: Worktree[] }>("/api/worktrees"),
  addWorktree: (path: string, ref: string, branch: string) =>
    req<{ worktrees: Worktree[] }>("/api/worktree/add", {
      method: "POST",
      body: JSON.stringify({ path, ref, branch }),
    }),
  removeWorktree: (path: string) =>
    req<{ worktrees: Worktree[] }>("/api/worktree/remove", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  pruneWorktrees: () =>
    req<{ worktrees: Worktree[] }>("/api/worktree/prune", { method: "POST", body: "{}" }),
  revealWorktree: (path: string) =>
    req<{ ok: true }>("/api/worktree/reveal", { method: "POST", body: JSON.stringify({ path }) }),
  checkout: (branch: string) =>
    req<{ repo: RepoInfo }>("/api/checkout", {
      method: "POST",
      body: JSON.stringify({ branch }),
    }),
  checkoutRemote: (remote: string, local: string) =>
    req<{ repo: RepoInfo }>("/api/checkout-remote", {
      method: "POST",
      body: JSON.stringify({ remote, local }),
    }),
  createBranch: (name: string, hash: string) =>
    req<{ repo: RepoInfo }>("/api/branch/create", {
      method: "POST",
      body: JSON.stringify({ name, hash }),
    }),
  deleteBranch: (name: string) =>
    req<{ branches: Branch[] }>("/api/branch/delete", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteRemoteBranch: (remote: string, branch: string) =>
    req<{ branches: RemoteBranch[] }>("/api/remote-branch/delete", {
      method: "POST",
      body: JSON.stringify({ remote, branch }),
    }),
  reset: (hash: string, mode: "hard" | "soft" | "mixed") =>
    req<{ repo: RepoInfo }>("/api/reset", {
      method: "POST",
      body: JSON.stringify({ hash, mode }),
    }),
  revert: (hash: string) =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("/api/revert", {
      method: "POST",
      body: JSON.stringify({ hash }),
    }),
  discardAll: () =>
    req<StatusResult>("/api/discard", { method: "POST", body: JSON.stringify({}) }),
  discardPaths: (paths: string[]) =>
    req<StatusResult>("/api/discard", { method: "POST", body: JSON.stringify({ paths }) }),
  deleteFile: (path: string) =>
    req<StatusResult>("/api/file/delete", { method: "POST", body: JSON.stringify({ path }) }),
  historyFiles: (includeHistory = false) =>
    req<HeadFileTree>(`/api/history-files${includeHistory ? "?includeHistory=true" : ""}`),
  historyFileContent: (path: string, head: string) => {
    const params = new URLSearchParams({ path, head });
    return req<HeadFileContent>(`/api/history-files/content?${params.toString()}`);
  },
  deleteFromHistory: (paths: string[], expectedHead: string, confirmation: string, recursive: boolean) =>
    req<HistoryDeleteResult>("/api/history-files/delete", {
      method: "POST",
      body: JSON.stringify({ paths, expectedHead, confirmation, recursive }),
    }),
  pruneRepo: () => req<{ ok: true }>("/api/repo/prune", { method: "POST", body: "{}" }),
  reveal: (path: string) =>
    req<{ ok: true }>("/api/reveal", { method: "POST", body: JSON.stringify({ path }) }),

  diff: (source: DiffSource, path: string, hash?: string) => {
    const params = new URLSearchParams({ source, path });
    if (hash) params.set("hash", hash);
    return req<DiffResult>(`/api/diff?${params.toString()}`);
  },
  blame: (path: string, revision?: string) => {
    const params = new URLSearchParams({ path });
    if (revision) params.set("revision", revision);
    return req<BlameResult>(`/api/blame?${params.toString()}`);
  },
  fileHistory: (path: string, skip: number, limit: number, query = "") => {
    const params = new URLSearchParams({
      path,
      skip: String(skip),
      limit: String(limit),
    });
    if (query) params.set("query", query);
    return req<FileHistoryResult>(`/api/file-history?${params.toString()}`);
  },

  stage: (paths: string[]) =>
    req<StatusResult>("/api/stage", {
      method: "POST",
      body: JSON.stringify({ paths }),
    }),
  stageAll: () =>
    req<StatusResult>("/api/stage", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    }),
  unstage: (paths: string[]) =>
    req<StatusResult>("/api/unstage", {
      method: "POST",
      body: JSON.stringify({ paths }),
    }),
  commit: (title: string, description: string, amend: boolean) =>
    req<{ hash: string; status: StatusResult; repo: RepoInfo | null }>("/api/commit", {
      method: "POST",
      body: JSON.stringify({ title, description, amend }),
    }),

  // Commit identity
  identity: () => req<IdentityInfo>("/api/identity"),
  setIdentity: (name: string, email: string) =>
    req<IdentityInfo>("/api/identity", { method: "POST", body: JSON.stringify({ name, email }) }),
  clearIdentity: () => req<IdentityInfo>("/api/identity", { method: "DELETE", body: "{}" }),

  // GitHub account (Personal Access Token)
  githubStatus: () => req<GitHubStatus>("/api/github/status"),
  githubSetToken: (token: string) =>
    req<{ configured: true; user: GitHubUser }>("/api/github/token", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  githubRevoke: () =>
    req<{ configured: false; user: null }>("/api/github/token", { method: "DELETE", body: "{}" }),
  githubRepos: () => req<{ repos: GitHubRepo[] }>("/api/github/repos"),

  // Remotes
  remotes: () => req<{ remotes: Remote[] }>("/api/remotes"),
  addRemote: (name: string, url: string) =>
    req<{ remotes: Remote[] }>("/api/remote/add", {
      method: "POST",
      body: JSON.stringify({ name, url }),
    }),
  removeRemote: (name: string) =>
    req<{ remotes: Remote[] }>("/api/remote/remove", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  createGitHubRepo: (opts: {
    name: string;
    description: string;
    private: boolean;
    remoteName: string;
  }) =>
    req<{ repo: { fullName: string; cloneUrl: string; htmlUrl: string }; remotes: Remote[] }>(
      "/api/github/create-repo",
      { method: "POST", body: JSON.stringify(opts) },
    ),

  // Pull requests (GitHub)
  prContext: () => req<PrContext>("/api/pr/context"),
  prBranches: (repo: string) =>
    req<{ branches: string[] }>(`/api/pr/branches?repo=${encodeURIComponent(repo)}`),
  prMeta: (repo: string) => req<PrMeta>(`/api/pr/meta?repo=${encodeURIComponent(repo)}`),
  prTemplate: (path: string) =>
    req<{ body: string }>(`/api/pr/template?path=${encodeURIComponent(path)}`),
  prCreate: (input: CreatePrInput) =>
    req<CreatedPr>("/api/pr/create", { method: "POST", body: JSON.stringify(input) }),

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
    }>("/api/push", { method: "POST", body: JSON.stringify({ force: force ?? false }) }),
  pull: (remote?: string, branch?: string) =>
    req<{ repo: RepoInfo | null; output: string; merge: MergeState; status: StatusResult }>("/api/pull", {
      method: "POST",
      body: JSON.stringify({ remote, branch }),
    }),

  // Checkout a commit (detached HEAD) / cherry-pick
  checkoutCommit: (hash: string) =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("/api/checkout-commit", {
      method: "POST",
      body: JSON.stringify({ hash }),
    }),
  cherryPick: (hash: string, noCommit: boolean) =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("/api/cherry-pick", {
      method: "POST",
      body: JSON.stringify({ hash, noCommit }),
    }),

  // Merge / conflict resolution
  merge: (branch: string, strategy: MergeStrategy) =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("/api/merge", {
      method: "POST",
      body: JSON.stringify({ branch, strategy }),
    }),
  mergeState: () => req<{ merge: MergeState }>("/api/merge/state"),
  conflictFile: (path: string) =>
    req<ConflictFileData>(`/api/conflict?path=${encodeURIComponent(path)}`),
  resolveConflict: (path: string, content: string, resolved: boolean) =>
    req<{ merge: MergeState; status: StatusResult }>("/api/conflict/resolve", {
      method: "POST",
      body: JSON.stringify({ path, content, resolved }),
    }),
  resolveAll: () =>
    req<{ merge: MergeState; status: StatusResult }>("/api/merge/resolve-all", {
      method: "POST",
      body: "{}",
    }),
  abortMerge: () =>
    req<{ repo: RepoInfo | null; merge: MergeState; status: StatusResult }>("/api/merge/abort", {
      method: "POST",
      body: "{}",
    }),

  // Stash
  stashes: () => req<{ stashes: StashEntry[] }>("/api/stashes"),
  stashPush: () =>
    req<{ stashed: boolean; output: string; status: StatusResult; stashes: StashEntry[] }>(
      "/api/stash/push",
      { method: "POST", body: "{}" },
    ),
  stashPop: (index: number) =>
    req<{ output: string; status: StatusResult; stashes: StashEntry[] }>("/api/stash/pop", {
      method: "POST",
      body: JSON.stringify({ index }),
    }),
  stashApply: (index: number) =>
    req<{ output: string; status: StatusResult; stashes: StashEntry[] }>("/api/stash/apply", {
      method: "POST",
      body: JSON.stringify({ index }),
    }),
  stashDrop: (index: number) =>
    req<{ stashes: StashEntry[] }>("/api/stash/drop", {
      method: "POST",
      body: JSON.stringify({ index }),
    }),
  terminalShells: () => req<{ shells: ShellInfo[]; cwd: string }>("/api/terminal/shells"),
  stashNote: (hash: string, title: string, description: string) =>
    req<{ stashes: StashEntry[] }>("/api/stash/note", {
      method: "POST",
      body: JSON.stringify({ hash, title, description }),
    }),
};
