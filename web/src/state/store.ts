import { create } from "zustand";
import { api, AuthError } from "../api/client";
import type {
  Branch,
  Commit,
  CommitFile,
  GitHubStatus,
  GitHubUser,
  RepoInfo,
  Remote,
  SelectedFile,
  StatusResult,
} from "../types";

const PAGE = 150;
const SIDEBAR_KEY = "gwui.sidebarCollapsed";

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

type ViewMode = "diff" | "file";
/** How the changes sidebar groups files. */
export type FileLayout = "path" | "tree";
export type ResetMode = "hard" | "soft" | "mixed";

/**
 * WebUI auth gate state: `loading` until the first status check resolves, then
 * `setup` (no password yet), `login` (password required), or `ok` (authed).
 */
export type AuthState = "loading" | "setup" | "login" | "ok";

/** Right-click context menu anchored to a commit. */
export interface CommitMenu {
  hash: string;
  x: number;
  y: number;
}

/** A pending destructive-action confirmation shown in the top banner. */
export interface ConfirmRequest {
  message: string;
  confirmLabel: string;
}

interface AppState {
  authState: AuthState;

  repo: RepoInfo | null;
  recent: string[];
  opening: boolean;
  error: string | null;
  /** Transient neutral message (e.g. "not implemented yet"). */
  notice: string | null;

  commits: Commit[];
  hasMore: boolean;
  loadingCommits: boolean;

  selectedCommitHash: string | null;
  commitFiles: CommitFile[];
  loadingCommitFiles: boolean;

  status: StatusResult;
  loadingStatus: boolean;
  committing: boolean;

  branches: Branch[];
  remotes: Remote[];
  githubStatus: GitHubStatus | null;
  /** A push/pull/create-remote network op is in flight. */
  remoteBusy: boolean;
  addRemoteOpen: boolean;
  githubDialogOpen: boolean;

  /** Whether the LOCAL/REMOTE left rail is collapsed (persisted). */
  sidebarCollapsed: boolean;

  selectedFile: SelectedFile | null;
  viewMode: ViewMode;
  fileLayout: FileLayout;

  commitMenu: CommitMenu | null;
  /** Commit hash the "Create branch here" dialog targets, if open. */
  branchDialogHash: string | null;
  /** Bumped on each refreshAll so open views (e.g. the diff) can refetch. */
  refreshTick: number;

  /** Active destructive-action confirmation, if any. */
  confirm: ConfirmRequest | null;

  init: () => Promise<void>;
  /** Set the initial password (first run), then enter the app. */
  setupPassword: (password: string, remember: boolean) => Promise<void>;
  login: (password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  /** Load recent list + current repo once authenticated. */
  loadWorkspace: () => Promise<void>;
  loadRecent: () => Promise<void>;
  openRepo: (path: string) => Promise<void>;
  closeRepo: () => void;

  loadCommits: (reset: boolean) => Promise<void>;
  selectCommit: (hash: string | null) => Promise<void>;

  loadBranches: () => Promise<void>;
  checkout: (branch: string) => Promise<void>;
  deleteBranch: (name: string) => Promise<void>;

  loadRemotes: () => Promise<void>;
  addRemote: (name: string, url: string) => Promise<void>;
  removeRemote: (name: string) => Promise<void>;
  createGitHubRepo: (opts: {
    name: string;
    description: string;
    private: boolean;
    remoteName: string;
  }) => Promise<string>;
  push: () => Promise<void>;
  pull: () => Promise<void>;

  loadGitHubStatus: () => Promise<void>;
  setGitHubToken: (token: string) => Promise<GitHubUser>;
  revokeGitHubToken: () => Promise<void>;

  openAddRemote: () => void;
  closeAddRemote: () => void;
  openGitHubDialog: () => void;
  closeGitHubDialog: () => void;
  toggleSidebar: () => void;

  /** Show the confirmation banner; resolves true if confirmed, false if cancelled. */
  requestConfirm: (message: string, confirmLabel?: string) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;

  openCommitMenu: (menu: CommitMenu) => void;
  closeCommitMenu: () => void;
  openBranchDialog: (hash: string) => void;
  closeBranchDialog: () => void;
  createBranchAt: (name: string, hash: string) => Promise<void>;
  resetToCommit: (hash: string, mode: ResetMode) => Promise<void>;
  revertCommit: (hash: string) => Promise<void>;

  refreshStatus: () => Promise<void>;
  /** Re-sync commits, status, and branches (e.g. on tab focus). */
  refreshAll: () => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  stageAll: () => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discardAll: () => Promise<void>;
  commit: (title: string, description: string, amend: boolean) => Promise<void>;

  openFile: (file: SelectedFile) => void;
  closeFile: () => void;
  setViewMode: (mode: ViewMode) => void;
  setFileLayout: (layout: FileLayout) => void;
  setError: (msg: string | null) => void;
  setNotice: (msg: string | null) => void;
}

const EMPTY_STATUS: StatusResult = { staged: [], unstaged: [] };

// Holds the resolver for the currently-open confirmation banner, if any.
let confirmResolver: ((ok: boolean) => void) | null = null;

export const useStore = create<AppState>((set, get) => ({
  authState: "loading",

  repo: null,
  recent: [],
  opening: false,
  error: null,
  notice: null,

  commits: [],
  hasMore: false,
  loadingCommits: false,

  selectedCommitHash: null,
  commitFiles: [],
  loadingCommitFiles: false,

  status: EMPTY_STATUS,
  loadingStatus: false,
  committing: false,

  branches: [],
  remotes: [],
  githubStatus: null,
  remoteBusy: false,
  addRemoteOpen: false,
  githubDialogOpen: false,

  sidebarCollapsed: readSidebarCollapsed(),

  selectedFile: null,
  viewMode: "diff",
  fileLayout: "tree",

  commitMenu: null,
  branchDialogHash: null,
  refreshTick: 0,
  confirm: null,

  async init() {
    try {
      const st = await api.authStatus();
      const authState: AuthState = st.configured
        ? st.authenticated
          ? "ok"
          : "login"
        : "setup";
      set({ authState });
      if (authState !== "ok") return;
    } catch (e) {
      // Server unreachable or unexpected error — fall back to the login screen.
      set({ authState: "login", error: errMsg(e) });
      return;
    }
    await get().loadWorkspace();
  },

  async setupPassword(password: string, remember: boolean) {
    // Errors propagate to the AuthGate so it can show them inline.
    await api.authSetup(password, remember);
    set({ authState: "ok", error: null });
    await get().loadWorkspace();
  },

  async login(password: string, remember: boolean) {
    await api.authLogin(password, remember);
    set({ authState: "ok", error: null });
    await get().loadWorkspace();
  },

  async logout() {
    try {
      await api.authLogout();
    } catch {
      /* clear locally regardless */
    }
    set({
      authState: "login",
      repo: null,
      commits: [],
      hasMore: false,
      selectedCommitHash: null,
      commitFiles: [],
      status: EMPTY_STATUS,
      selectedFile: null,
      branches: [],
    });
  },

  async loadWorkspace() {
    await get().loadRecent();
    // GitHub connection is repo-independent; load it regardless.
    get().loadGitHubStatus();
    try {
      const { repo } = await api.currentRepo();
      if (repo) {
        set({ repo });
        await Promise.all([
          get().loadCommits(true),
          get().refreshStatus(),
          get().loadBranches(),
          get().loadRemotes(),
        ]);
      }
    } catch (e) {
      reportError(set, e);
    }
  },

  async loadRecent() {
    try {
      const { recent } = await api.recent();
      set({ recent });
    } catch {
      /* non-fatal */
    }
  },

  async openRepo(path: string) {
    set({ opening: true, error: null });
    try {
      const { repo } = await api.openRepo(path);
      set({
        repo,
        commits: [],
        selectedCommitHash: null,
        commitFiles: [],
        selectedFile: null,
        status: EMPTY_STATUS,
      });
      await get().loadRecent();
      await Promise.all([
        get().loadCommits(true),
        get().refreshStatus(),
        get().loadBranches(),
        get().loadRemotes(),
      ]);
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ opening: false });
    }
  },

  closeRepo() {
    set({
      repo: null,
      commits: [],
      hasMore: false,
      selectedCommitHash: null,
      commitFiles: [],
      status: EMPTY_STATUS,
      selectedFile: null,
    });
  },

  async loadCommits(reset: boolean) {
    if (get().loadingCommits) return;
    const skip = reset ? 0 : get().commits.length;
    set({ loadingCommits: true });
    try {
      const { commits, hasMore } = await api.commits(skip, PAGE);
      set((s) => ({
        commits: reset ? commits : [...s.commits, ...commits],
        hasMore,
      }));
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ loadingCommits: false });
    }
  },

  async selectCommit(hash: string | null) {
    set({ selectedCommitHash: hash, selectedFile: null });
    if (!hash) {
      set({ commitFiles: [] });
      return;
    }
    set({ loadingCommitFiles: true });
    try {
      const { files } = await api.commitFiles(hash);
      // Guard against a race if the user clicked another commit meanwhile.
      if (get().selectedCommitHash === hash) set({ commitFiles: files });
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ loadingCommitFiles: false });
    }
  },

  async loadBranches() {
    try {
      const { branches } = await api.branches();
      set({ branches });
    } catch {
      /* non-fatal */
    }
  },

  async checkout(branch: string) {
    set({ error: null });
    try {
      const { repo } = await api.checkout(branch);
      set({
        repo,
        selectedCommitHash: null,
        commitFiles: [],
        selectedFile: null,
      });
      await Promise.all([get().loadCommits(true), get().refreshStatus(), get().loadBranches()]);
    } catch (e) {
      reportError(set, e);
    }
  },

  async deleteBranch(name: string) {
    set({ error: null });
    try {
      const { branches } = await api.deleteBranch(name);
      set({ branches });
      // A deleted branch's ref badge should disappear from the graph.
      await get().loadCommits(true);
    } catch (e) {
      reportError(set, e);
    }
  },

  async loadRemotes() {
    try {
      const { remotes } = await api.remotes();
      set({ remotes });
    } catch {
      /* non-fatal */
    }
  },

  async addRemote(name: string, url: string) {
    // Errors propagate so the Add Remote dialog can show them inline.
    const { remotes } = await api.addRemote(name, url);
    set({ remotes });
  },

  async removeRemote(name: string) {
    set({ error: null });
    try {
      const { remotes } = await api.removeRemote(name);
      set({ remotes });
    } catch (e) {
      reportError(set, e);
    }
  },

  async createGitHubRepo(opts) {
    set({ remoteBusy: true });
    try {
      const { repo, remotes } = await api.createGitHubRepo(opts);
      set({ remotes });
      await Promise.all([get().loadCommits(true), get().loadBranches()]);
      set({ notice: `Created ${repo.fullName} and pushed ${get().repo?.branch ?? ""}.` });
      return repo.htmlUrl;
    } finally {
      set({ remoteBusy: false });
    }
  },

  async push() {
    if (get().remoteBusy) return;
    set({ remoteBusy: true, error: null });
    try {
      const { branch, branches } = await api.push();
      set({ branches });
      await get().loadCommits(true);
      set({ notice: `Pushed ${branch}.` });
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ remoteBusy: false });
    }
  },

  async pull() {
    if (get().remoteBusy) return;
    set({ remoteBusy: true, error: null });
    try {
      await api.pull();
      await Promise.all([get().loadCommits(true), get().refreshStatus(), get().loadBranches()]);
      set({ notice: "Pulled latest changes." });
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ remoteBusy: false });
    }
  },

  async loadGitHubStatus() {
    try {
      const githubStatus = await api.githubStatus();
      set({ githubStatus });
    } catch {
      /* non-fatal */
    }
  },

  async setGitHubToken(token: string) {
    // Errors propagate to the dialog for inline display.
    const { user } = await api.githubSetToken(token);
    set({ githubStatus: { configured: true, user } });
    return user;
  },

  async revokeGitHubToken() {
    set({ error: null });
    try {
      const status = await api.githubRevoke();
      set({ githubStatus: status });
    } catch (e) {
      reportError(set, e);
    }
  },

  openAddRemote() {
    set({ addRemoteOpen: true });
  },
  closeAddRemote() {
    set({ addRemoteOpen: false });
  },
  openGitHubDialog() {
    set({ githubDialogOpen: true });
  },
  closeGitHubDialog() {
    set({ githubDialogOpen: false });
  },
  toggleSidebar() {
    const next = !get().sidebarCollapsed;
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    } catch {
      /* ignore storage failures */
    }
    set({ sidebarCollapsed: next });
  },

  requestConfirm(message: string, confirmLabel = "Confirm") {
    return new Promise<boolean>((resolve) => {
      confirmResolver = resolve;
      set({ confirm: { message, confirmLabel } });
    });
  },
  resolveConfirm(ok: boolean) {
    const resolve = confirmResolver;
    confirmResolver = null;
    set({ confirm: null });
    resolve?.(ok);
  },

  openCommitMenu(menu: CommitMenu) {
    set({ commitMenu: menu });
  },
  closeCommitMenu() {
    set({ commitMenu: null });
  },
  openBranchDialog(hash: string) {
    set({ branchDialogHash: hash, commitMenu: null });
  },
  closeBranchDialog() {
    set({ branchDialogHash: null });
  },

  async createBranchAt(name: string, hash: string) {
    set({ error: null, branchDialogHash: null, commitMenu: null });
    try {
      const { repo } = await api.createBranch(name, hash);
      set({ repo });
      await Promise.all([get().loadCommits(true), get().refreshStatus(), get().loadBranches()]);
    } catch (e) {
      reportError(set, e);
    }
  },

  async resetToCommit(hash: string, mode: ResetMode) {
    set({ error: null, commitMenu: null });
    try {
      const { repo } = await api.reset(hash, mode);
      set({ repo, selectedCommitHash: null, commitFiles: [], selectedFile: null });
      await Promise.all([get().loadCommits(true), get().refreshStatus(), get().loadBranches()]);
    } catch (e) {
      reportError(set, e);
    }
  },

  async revertCommit(hash: string) {
    set({ error: null, commitMenu: null });
    try {
      const { repo } = await api.revert(hash);
      set({ repo, selectedCommitHash: null, commitFiles: [], selectedFile: null });
      await Promise.all([get().loadCommits(true), get().refreshStatus(), get().loadBranches()]);
    } catch (e) {
      reportError(set, e);
    }
  },

  async refreshStatus() {
    set({ loadingStatus: true });
    try {
      const status = await api.status();
      set({ status });
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ loadingStatus: false });
    }
  },

  async refreshAll() {
    const s = get();
    if (!s.repo || s.opening) return;
    // Bump the tick first so an open diff refetches alongside the lists.
    set({ refreshTick: s.refreshTick + 1 });
    // Reload as many commits as are currently paged in, so a deep scroll
    // position survives the refresh (server caps the page at 1000).
    const count = Math.min(1000, Math.max(PAGE, s.commits.length));
    const commitsPromise = api
      .commits(0, count)
      .then(({ commits, hasMore }) => set({ commits, hasMore }))
      .catch((e) => reportError(set, e));
    // A selected commit's file list is immutable, so it needs no reload.
    await Promise.all([commitsPromise, s.refreshStatus(), s.loadBranches(), s.loadRemotes()]);
  },

  async stage(paths: string[]) {
    try {
      const status = await api.stage(paths);
      set({ status });
      syncSelectedAfterStage(get, set, paths, true);
    } catch (e) {
      reportError(set, e);
    }
  },

  async stageAll() {
    try {
      const status = await api.stageAll();
      set({ status });
    } catch (e) {
      reportError(set, e);
    }
  },

  async unstage(paths: string[]) {
    try {
      const status = await api.unstage(paths);
      set({ status });
      syncSelectedAfterStage(get, set, paths, false);
    } catch (e) {
      reportError(set, e);
    }
  },

  async discardAll() {
    try {
      const status = await api.discardAll();
      set({ status, selectedFile: null });
    } catch (e) {
      reportError(set, e);
    }
  },

  async commit(title: string, description: string, amend: boolean) {
    set({ committing: true, error: null });
    try {
      const { status } = await api.commit(title, description, amend);
      set({ status, selectedFile: null });
      await Promise.all([get().loadCommits(true), get().loadBranches()]);
    } catch (e) {
      reportError(set, e);
      throw e;
    } finally {
      set({ committing: false });
    }
  },

  openFile(file: SelectedFile) {
    set({ selectedFile: file, viewMode: "diff" });
  },

  closeFile() {
    set({ selectedFile: null });
  },

  setViewMode(mode: ViewMode) {
    set({ viewMode: mode });
  },

  setFileLayout(layout: FileLayout) {
    set({ fileLayout: layout });
  },

  setError(msg: string | null) {
    set({ error: msg });
  },

  setNotice(msg: string | null) {
    set({ notice: msg });
  },
}));

/** When a viewed working-file is staged/unstaged, flip its source so the viewer follows it. */
function syncSelectedAfterStage(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  paths: string[],
  nowStaged: boolean,
) {
  const sel = get().selectedFile;
  if (!sel || sel.source === "commit") return;
  if (!paths.includes(sel.path)) return;
  set({
    selectedFile: {
      ...sel,
      source: nowStaged ? "staged" : "unstaged",
      staged: nowStaged,
    },
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Route an action error: a 401 (session expired/invalid) drops back to the
 * login screen; anything else surfaces as the error toast.
 */
function reportError(set: (partial: Partial<AppState>) => void, e: unknown): void {
  if (e instanceof AuthError) {
    set({ authState: "login" });
    return;
  }
  set({ error: errMsg(e) });
}
