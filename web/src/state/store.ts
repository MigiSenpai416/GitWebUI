import { create } from "zustand";
import { api, AuthError, setRequestRepoRoot } from "../api/client";
import { openExternal } from "../desktop";
import type {
  Branch,
  Commit,
  CommitFile,
  ConflictFileData,
  CreatePrInput,
  CreatedPr,
  GitHubStatus,
  GitHubUser,
  IdentityInfo,
  MergeState,
  PushForce,
  RepoInfo,
  Remote,
  RemoteBranch,
  SelectedFile,
  StashEntry,
  StatusResult,
  Worktree,
} from "../types";

const PAGE = 150;
const SIDEBAR_KEY = "gwui.sidebarCollapsed";
const TABS_KEY = "gwui.tabs";
const VISIBLE_KEY = "gwui.visibleRefs";
const TERMINAL_H_KEY = "gwui.terminalHeight";

/** Per-repo set of extra remote branch refs whose commits are shown in the log. */
function readVisibleMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(VISIBLE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
/** Saved visible set for a repo, or null if it was never set (so a default applies). */
function readVisibleFor(root: string): string[] | null {
  const v = readVisibleMap()[root];
  return Array.isArray(v) ? v : null;
}
function writeVisibleFor(root: string, refs: string[]): void {
  if (!root) return;
  try {
    const map = readVisibleMap();
    // Always store (even empty) so an explicit "hide everything" is remembered
    // and distinguishable from a repo opened for the first time.
    map[root] = refs;
    localStorage.setItem(VISIBLE_KEY, JSON.stringify(map));
  } catch {
    /* ignore storage failures */
  }
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

/** Terminal dock: tall enough to hold a command's output without hiding the graph. */
const DEFAULT_TERMINAL_H = 260;
const MIN_TERMINAL_H = 120;

function readTerminalHeight(): number {
  try {
    const n = Number(localStorage.getItem(TERMINAL_H_KEY));
    return Number.isFinite(n) && n >= MIN_TERMINAL_H ? n : DEFAULT_TERMINAL_H;
  } catch {
    return DEFAULT_TERMINAL_H;
  }
}

/**
 * One workspace tab. A tab with `root === null` is an empty "New Tab" showing
 * the repository picker; otherwise it holds an open repo. The active tab's repo
 * data (commits, status, branches, …) lives in the top-level store fields.
 */
export interface RepoTab {
  id: string;
  root: string | null;
  name: string;
  branch: string;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

function pickerTab(): RepoTab {
  return { id: uid(), root: null, name: "New Tab", branch: "" };
}

function readTabs(): { tabs: RepoTab[]; activeTabId: string | null } {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { tabs?: RepoTab[]; activeTabId?: string | null };
      if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        return { tabs: parsed.tabs, activeTabId: parsed.activeTabId ?? parsed.tabs[0].id };
      }
    }
  } catch {
    /* ignore malformed storage */
  }
  const t = pickerTab();
  return { tabs: [t], activeTabId: t.id };
}

function persistTabs(tabs: RepoTab[], activeTabId: string | null): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeTabId }));
  } catch {
    /* ignore storage failures */
  }
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Full ref for a local branch — the log revision used to show its commits. */
export function localRef(name: string): string {
  return `refs/heads/${name}`;
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

/** Context menu anchored to a stash row in the commit list. */
export interface StashMenu {
  index: number;
  x: number;
  y: number;
}

/** Right-click menu on a file or folder in the changes panel. */
export interface ChangesMenu {
  kind: "file" | "folder";
  x: number;
  y: number;
  /** Repo-relative paths affected (one file, or every file under a folder). */
  paths: string[];
  /** Display name (file or folder) for confirmation copy. */
  label: string;
  /** Whether the target sits in the staged section (Stage vs Unstage). */
  staged: boolean;
  /** For a file: its single repo-relative path. */
  filePath?: string;
  /** For a folder: its repo-relative path (for Open Folder). */
  folderPath?: string;
}

/**
 * The long-running action currently in flight, so the control that started it
 * can show a spinner in place of its icon.
 */
export type BusyAction = "push" | "pull" | "stash" | "pop" | "remote" | "pr";

export type ConfirmKind = "primary" | "neutral" | "danger";

/** One button in the confirmation banner; `value` is what the promise resolves to. */
export interface ConfirmButton {
  label: string;
  value: string;
  kind: ConfirmKind;
}

/** A pending confirmation/choice shown in the top banner. */
export interface ConfirmRequest {
  message: string;
  buttons: ConfirmButton[];
  /** When set, the banner shows a checkbox with this label (e.g. "Don't ask again"). */
  checkbox?: string;
}

export type ToastKind = "error" | "notice";

/** One message in the toast stack. */
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /**
   * Bumped when the same message is raised again while it is still up, so the
   * toast restarts its countdown instead of stacking a duplicate.
   */
  seq: number;
}

/** How many toasts are on screen at once; a new one evicts the oldest. */
export const MAX_TOASTS = 3;

let nextToastId = 1;

/** Append a toast to `list`, collapsing a repeat of the newest one. */
function appendToast(list: ToastItem[], kind: ToastKind, message: string): ToastItem[] {
  const newest = list[list.length - 1];
  if (newest && newest.kind === kind && newest.message === message) {
    return [...list.slice(0, -1), { ...newest, seq: newest.seq + 1 }];
  }
  return [...list, { id: nextToastId++, kind, message, seq: 0 }].slice(-MAX_TOASTS);
}

/** Raise a toast from anywhere that holds `set` (actions and module helpers). */
function raise(set: StoreSet, kind: ToastKind, message: string): void {
  set((s) => ({ toasts: appendToast(s.toasts, kind, message) }));
}

interface AppState {
  authState: AuthState;

  /** Open workspace tabs and which one is active. */
  tabs: RepoTab[];
  activeTabId: string | null;
  cloneDialogOpen: boolean;
  createDialogOpen: boolean;

  repo: RepoInfo | null;
  recent: string[];
  opening: boolean;
  /** Results of recent actions, oldest first; the newest sits nearest the corner. */
  toasts: ToastItem[];

  commits: Commit[];
  hasMore: boolean;
  loadingCommits: boolean;

  selectedCommitHash: string | null;
  /**
   * The stash open in the side pane, keyed by its commit — the stash@{N} index
   * shifts whenever anything is pushed or dropped, the commit doesn't.
   */
  selectedStashHash: string | null;
  commitFiles: CommitFile[];
  loadingCommitFiles: boolean;

  status: StatusResult;
  loadingStatus: boolean;
  committing: boolean;

  /** In-progress merge/rebase/revert conflict state, or null when clean. */
  mergeState: MergeState | null;
  /** Every path seen conflicted during this operation (for the Resolved list). */
  mergeSeen: string[];
  /** The conflicted file open in the resolver, or null. */
  conflictPath: string | null;
  conflictData: ConflictFileData | null;
  conflictLoading: boolean;

  branches: Branch[];
  remotes: Remote[];
  remoteBranches: RemoteBranch[];
  worktrees: Worktree[];
  /** Whether the "Create Worktree" panel is showing in the content area. */
  worktreeCreateOpen: boolean;
  /** Extra remote branch refs (beyond HEAD) whose commits show in the log. */
  visibleRefs: string[];
  stashes: StashEntry[];
  githubStatus: GitHubStatus | null;
  /** A push/pull/create-remote network op is in flight. */
  remoteBusy: boolean;
  /** Which one, so its button can show the wait instead of just going dim. */
  busyAction: BusyAction | null;
  addRemoteOpen: boolean;
  githubDialogOpen: boolean;
  identityDialogOpen: boolean;
  identity: IdentityInfo | null;
  /** Whether the Create Pull Request dialog is open. */
  prDialogOpen: boolean;
  /** Branch the PR dialog opened for (null → the current branch). */
  prHeadBranch: string | null;

  /** Whether the LOCAL/REMOTE left rail is collapsed (persisted). */
  sidebarCollapsed: boolean;
  /** Whether the terminal dock is showing, and how tall it is (persisted). */
  terminalOpen: boolean;
  terminalHeight: number;

  selectedFile: SelectedFile | null;
  viewMode: ViewMode;
  fileLayout: FileLayout;

  commitMenu: CommitMenu | null;
  stashMenu: StashMenu | null;
  changesMenu: ChangesMenu | null;
  /** Commit hash the "Create branch here" dialog targets, if open. */
  branchDialogHash: string | null;
  /** Bumped on each refreshAll so open views (e.g. the diff) can refetch. */
  refreshTick: number;

  /** Active destructive-action confirmation, if any. */
  confirm: ConfirmRequest | null;
  /** Current state of the active confirmation's checkbox (if it has one). */
  confirmCheckbox: boolean;

  init: () => Promise<void>;
  /** Set the initial password (first run), then enter the app. */
  setupPassword: (password: string, remember: boolean) => Promise<void>;
  login: (password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  /** Load recent list + current repo once authenticated. */
  loadWorkspace: () => Promise<void>;
  loadRecent: () => Promise<void>;
  openRepo: (path: string) => Promise<void>;
  cloneRepo: (dir: string, url: string) => Promise<void>;
  createRepo: (dir: string, name: string, branch: string) => Promise<void>;
  createGitHubRepoNew: (opts: {
    name: string;
    description: string;
    private: boolean;
    branch: string;
    clone: boolean;
    dir: string;
  }) => Promise<void>;
  closeRepo: () => void;

  /** Tabs. */
  newTab: () => void;
  selectTab: (id: string) => Promise<void>;
  closeTab: (id: string) => void;
  openCloneDialog: () => void;
  closeCloneDialog: () => void;
  openCreateDialog: () => void;
  closeCreateDialog: () => void;

  loadCommits: (reset: boolean) => Promise<void>;
  selectCommit: (hash: string | null) => Promise<void>;
  selectStash: (hash: string | null) => Promise<void>;
  saveStashNote: (hash: string, title: string, description: string) => Promise<void>;

  loadBranches: () => Promise<void>;
  loadRemoteBranches: () => Promise<void>;
  toggleBranchVisibility: (ref: string) => void;
  checkout: (branch: string) => Promise<void>;

  loadWorktrees: () => Promise<void>;
  openWorktreeCreate: () => void;
  closeWorktreeCreate: () => void;
  createWorktree: (path: string, ref: string, branch: string) => Promise<void>;
  openWorktree: (path: string) => Promise<void>;
  removeWorktree: (path: string) => Promise<void>;
  pruneWorktrees: () => Promise<void>;
  revealWorktree: (path: string) => Promise<void>;
  checkoutRemote: (remote: string, local: string) => Promise<void>;
  deleteBranch: (name: string) => Promise<void>;
  /** Delete a branch on the remote itself (e.g. "origin", "feature/x"). */
  deleteRemoteBranch: (remote: string, branch: string) => Promise<void>;

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
  pull: (remote?: string, branch?: string) => Promise<void>;

  openPullRequest: (branch?: string) => void;
  closePullRequest: () => void;
  /** Make sure `branch` is on the remote before a PR targets it (may prompt to push). */
  ensureBranchPushed: (branch: string) => Promise<{ ok: boolean; reason?: string }>;
  createPullRequest: (input: CreatePrInput) => Promise<CreatedPr>;

  loadMergeState: () => Promise<void>;
  mergeBranch: (name: string) => Promise<void>;
  checkoutCommit: (hash: string) => Promise<void>;
  cherryPick: (hash: string, noCommit: boolean) => Promise<void>;
  abortMerge: () => Promise<void>;
  openConflict: (path: string) => Promise<void>;
  closeConflict: () => void;
  saveResolution: (path: string, content: string, resolved: boolean) => Promise<void>;
  markAllResolved: () => Promise<void>;

  loadStashes: () => Promise<void>;
  stash: () => Promise<void>;
  stashPop: (index?: number) => Promise<void>;
  stashApply: (index: number) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;
  openStashMenu: (menu: StashMenu) => void;
  closeStashMenu: () => void;

  loadGitHubStatus: () => Promise<void>;
  setGitHubToken: (token: string) => Promise<GitHubUser>;
  revokeGitHubToken: () => Promise<void>;

  loadIdentity: () => Promise<void>;
  saveIdentity: (name: string, email: string) => Promise<void>;
  clearIdentity: () => Promise<void>;
  openIdentityDialog: () => void;
  closeIdentityDialog: () => void;

  openAddRemote: () => void;
  closeAddRemote: () => void;
  openGitHubDialog: () => void;
  closeGitHubDialog: () => void;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  setTerminalHeight: (px: number) => void;

  /** Show a two-button confirm banner; resolves true if confirmed, false otherwise. */
  requestConfirm: (message: string, confirmLabel?: string) => Promise<boolean>;
  /** Show a banner with custom buttons; resolves the chosen value, or null if dismissed. */
  requestChoice: (
    message: string,
    buttons: ConfirmButton[],
    options?: { checkbox?: string },
  ) => Promise<string | null>;
  resolveConfirm: (value: string | null) => void;
  setConfirmCheckbox: (checked: boolean) => void;

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
  discardPaths: (paths: string[]) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  revealPath: (path: string) => Promise<void>;
  openChangesMenu: (menu: ChangesMenu) => void;
  closeChangesMenu: () => void;
  commit: (title: string, description: string, amend: boolean) => Promise<void>;

  openFile: (file: SelectedFile) => void;
  closeFile: () => void;
  setViewMode: (mode: ViewMode) => void;
  setFileLayout: (layout: FileLayout) => void;
  setError: (msg: string) => void;
  setNotice: (msg: string) => void;
  dismissToast: (id: number) => void;
}

const EMPTY_STATUS: StatusResult = { staged: [], unstaged: [] };

// Holds the resolver for the currently-open confirmation banner, if any.
let confirmResolver: ((value: string | null) => void) | null = null;

const initialTabs = readTabs();
// Identifies the newest asynchronous tab switch. Opening a repository can take
// long enough for the user to choose another tab; an older response must never
// hydrate over the newer selection.
let tabSelectionGeneration = 0;

export const useStore = create<AppState>((set, get) => ({
  authState: "loading",

  tabs: initialTabs.tabs,
  activeTabId: initialTabs.activeTabId,
  cloneDialogOpen: false,
  createDialogOpen: false,

  repo: null,
  recent: [],
  opening: false,
  toasts: [],

  commits: [],
  hasMore: false,
  loadingCommits: false,

  selectedCommitHash: null,
  selectedStashHash: null,
  commitFiles: [],
  loadingCommitFiles: false,

  status: EMPTY_STATUS,
  loadingStatus: false,
  committing: false,

  mergeState: null,
  mergeSeen: [],
  conflictPath: null,
  conflictData: null,
  conflictLoading: false,

  branches: [],
  remotes: [],
  remoteBranches: [],
  worktrees: [],
  worktreeCreateOpen: false,
  visibleRefs: [],
  stashes: [],
  githubStatus: null,
  remoteBusy: false,
  busyAction: null,
  addRemoteOpen: false,
  githubDialogOpen: false,
  identityDialogOpen: false,
  identity: null,
  prDialogOpen: false,
  prHeadBranch: null,

  sidebarCollapsed: readSidebarCollapsed(),
  terminalOpen: false,
  terminalHeight: readTerminalHeight(),

  selectedFile: null,
  viewMode: "diff",
  fileLayout: "tree",

  commitMenu: null,
  stashMenu: null,
  changesMenu: null,
  branchDialogHash: null,
  refreshTick: 0,
  confirm: null,
  confirmCheckbox: false,

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
      set({ authState: "login" });
      raise(set, "error", errMsg(e));
      return;
    }
    await get().loadWorkspace();
  },

  async setupPassword(password: string, remember: boolean) {
    // Errors propagate to the AuthGate so it can show them inline.
    await api.authSetup(password, remember);
    set({ authState: "ok" });
    await get().loadWorkspace();
  },

  async login(password: string, remember: boolean) {
    await api.authLogin(password, remember);
    set({ authState: "ok" });
    await get().loadWorkspace();
  },

  async logout() {
    try {
      await api.authLogout();
    } catch {
      /* clear locally regardless */
    }
    setRequestRepoRoot(null);
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
    const { tabs, activeTabId } = get();
    const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
    if (active) set({ activeTabId: active.id });
    if (active?.root) {
      await get().selectTab(active.id);
    } else {
      showPicker(set);
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
    const generation = ++tabSelectionGeneration;
    set({ opening: true });
    try {
      const { repo } = await api.openRepo(path);
      if (generation !== tabSelectionGeneration) return;
      await adoptRepo(get, set, repo);
      await get().loadRecent();
    } catch (e) {
      if (generation === tabSelectionGeneration) reportError(set, e);
    } finally {
      if (generation === tabSelectionGeneration) set({ opening: false });
    }
  },

  async cloneRepo(dir: string, url: string) {
    // Errors propagate so the Clone dialog can show them inline.
    const generation = ++tabSelectionGeneration;
    set({ opening: true });
    try {
      const { repo } = await api.cloneRepo(dir, url);
      if (generation === tabSelectionGeneration) await adoptRepo(get, set, repo);
      await get().loadRecent();
    } finally {
      if (generation === tabSelectionGeneration) set({ opening: false });
    }
  },

  async createRepo(dir: string, name: string, branch: string) {
    // Errors propagate so the Create dialog can show them inline.
    const generation = ++tabSelectionGeneration;
    set({ opening: true });
    try {
      const { repo } = await api.createRepo(dir, name, branch);
      if (generation === tabSelectionGeneration) await adoptRepo(get, set, repo);
      await get().loadRecent();
    } finally {
      if (generation === tabSelectionGeneration) set({ opening: false });
    }
  },

  async createGitHubRepoNew(opts) {
    // Errors propagate so the Create dialog can show them inline.
    const generation = ++tabSelectionGeneration;
    set({ opening: true });
    try {
      const { created, repo } = await api.createGitHubRepoNew(opts);
      if (repo && generation === tabSelectionGeneration) {
        await adoptRepo(get, set, repo);
      } else if (!repo) {
        raise(set, "notice", `Created ${created.fullName} on GitHub.`);
      }
      await get().loadRecent();
    } finally {
      if (generation === tabSelectionGeneration) set({ opening: false });
    }
  },

  newTab() {
    ++tabSelectionGeneration;
    const t = pickerTab();
    const tabs = [...get().tabs, t];
    set({ tabs, activeTabId: t.id, opening: false });
    persistTabs(tabs, t.id);
    showPicker(set);
  },

  async selectTab(id: string) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    const generation = ++tabSelectionGeneration;
    set({ activeTabId: id });
    if (!tab.root) {
      persistTabs(get().tabs, id);
      set({ opening: false });
      showPicker(set);
      return;
    }
    set({ opening: true });
    try {
      // Re-open on the backend: idempotent, and re-registers the repo after a
      // server restart so data requests for this tab keep working.
      const { repo } = await api.openRepo(tab.root);
      // A later tab click won while this repository was opening. Applying this
      // stale response would show one tab as active while targeting another
      // repo with every subsequent API request.
      if (generation !== tabSelectionGeneration || get().activeTabId !== id) return;
      const tabs = get().tabs.map((t) =>
        t.id === id ? { ...t, branch: repo.branch, name: basename(repo.root) } : t,
      );
      set({ tabs });
      persistTabs(tabs, id);
      await hydrateRepo(get, set, repo);
    } catch (e) {
      if (generation === tabSelectionGeneration) reportError(set, e);
    } finally {
      if (generation === tabSelectionGeneration) set({ opening: false });
    }
  },

  closeTab(id: string) {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const closing = state.tabs[idx];
    if (closing.root) api.closeRepo(closing.root).catch(() => undefined);
    let tabs = state.tabs.filter((t) => t.id !== id);
    if (tabs.length === 0) tabs = [pickerTab()];
    if (state.activeTabId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      set({ tabs });
      persistTabs(tabs, next.id);
      void get().selectTab(next.id);
    } else {
      set({ tabs });
      persistTabs(tabs, state.activeTabId);
    }
  },

  openCloneDialog() {
    set({ cloneDialogOpen: true });
  },
  closeCloneDialog() {
    set({ cloneDialogOpen: false });
  },
  openCreateDialog() {
    set({ createDialogOpen: true });
  },
  closeCreateDialog() {
    set({ createDialogOpen: false });
  },

  // Turn the active tab back into an empty picker ("Open a different repository").
  closeRepo() {
    ++tabSelectionGeneration;
    const state = get();
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    if (active?.root) api.closeRepo(active.root).catch(() => undefined);
    const tabs = state.tabs.map((t) =>
      t.id === state.activeTabId ? { ...t, root: null, name: "New Tab", branch: "" } : t,
    );
    set({ tabs, opening: false });
    persistTabs(tabs, state.activeTabId);
    showPicker(set);
  },

  async loadCommits(reset: boolean) {
    if (get().loadingCommits) return;
    const root = get().repo?.root;
    if (!root) return;
    const skip = reset ? 0 : get().commits.length;
    set({ loadingCommits: true });
    try {
      const { commits, hasMore } = await api.commits(skip, PAGE, get().visibleRefs);
      if (get().repo?.root !== root) return;
      set((s) => ({
        commits: reset ? commits : [...s.commits, ...commits],
        hasMore,
      }));
    } catch (e) {
      if (get().repo?.root === root) reportError(set, e);
    } finally {
      if (get().repo?.root === root) set({ loadingCommits: false });
    }
  },

  async selectCommit(hash: string | null) {
    // A commit and a stash both own the side pane, so selecting one drops the other.
    set({ selectedCommitHash: hash, selectedStashHash: null, selectedFile: null });
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

  /**
   * Open a stash in the side pane. A stash is a commit, so its file list and
   * diffs come from the same place a commit's do.
   */
  async selectStash(hash: string | null) {
    set({ selectedStashHash: hash, selectedCommitHash: null, selectedFile: null });
    if (!hash) {
      set({ commitFiles: [] });
      return;
    }
    set({ loadingCommitFiles: true, commitFiles: [] });
    try {
      const { files } = await api.commitFiles(hash);
      if (get().selectedStashHash === hash) set({ commitFiles: files });
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ loadingCommitFiles: false });
    }
  },

  /** Store the user's own title/description for a stash as a git note. */
  async saveStashNote(hash: string, title: string, description: string) {
    try {
      const { stashes } = await api.stashNote(hash, title, description);
      set({ stashes });
      raise(set, "notice", title.trim() ? "Saved the stash note." : "Cleared the stash note.");
    } catch (e) {
      reportError(set, e);
    }
  },

  async loadBranches() {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { branches } = await api.branches();
      if (get().repo?.root !== root) return;
      set({ branches });
      // Drop any visible LOCAL refs whose branch no longer exists (e.g. deleted
      // elsewhere); leave remote refs to loadRemoteBranches.
      const cur = get().visibleRefs;
      const pruned = cur.filter(
        (ref) => !ref.startsWith("refs/heads/") || branches.some((b) => localRef(b.name) === ref),
      );
      if (pruned.length !== cur.length) {
        set({ visibleRefs: pruned });
        writeVisibleFor(get().repo?.root ?? "", pruned);
      }
    } catch {
      /* non-fatal */
    }
  },

  async loadRemoteBranches() {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { branches } = await api.remoteBranches();
      if (get().repo?.root !== root) return;
      set({ remoteBranches: branches });
      // Drop any visible REMOTE refs whose branch no longer exists on the remote.
      // Local refs (refs/heads/…) are left untouched — loadBranches prunes those.
      const cur = get().visibleRefs;
      const pruned = cur.filter(
        (ref) => !ref.startsWith("refs/remotes/") || branches.some((b) => b.ref === ref),
      );
      if (pruned.length !== cur.length) {
        set({ visibleRefs: pruned });
        writeVisibleFor(get().repo?.root ?? "", pruned);
      }
    } catch {
      /* non-fatal */
    }
  },

  toggleBranchVisibility(ref: string) {
    const cur = get().visibleRefs;
    const next = cur.includes(ref) ? cur.filter((r) => r !== ref) : [...cur, ref];
    set({ visibleRefs: next });
    writeVisibleFor(get().repo?.root ?? "", next);
    get().loadCommits(true);
  },

  async checkout(branch: string) {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { repo } = await api.checkout(branch);
      if (!isActiveRepo(get, root)) return;
      set({
        repo,
        selectedCommitHash: null,
        commitFiles: [],
        selectedFile: null,
      });
      syncActiveTab(get, set, repo);
      await refreshRepoData(get, set, root);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async checkoutRemote(remote: string, local: string) {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { repo } = await api.checkoutRemote(remote, local);
      if (!isActiveRepo(get, root)) return;
      set({ repo, selectedCommitHash: null, commitFiles: [], selectedFile: null });
      syncActiveTab(get, set, repo);
      await refreshRepoData(get, set, root);
      if (!isActiveRepo(get, root)) return;
      // A same-named local branch may already exist. In that case the server
      // deliberately checks out the local branch without rewriting its
      // upstream, so report the refreshed branch's real tracking state rather
      // than claiming it tracks the remote row the user clicked.
      const upstream = get().branches.find((b) => b.name === local)?.upstream;
      raise(
        set,
        "notice",
        upstream ? `Checked out ${local} (tracking ${upstream}).` : `Checked out ${local}.`,
      );
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async deleteBranch(name: string) {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { branches } = await api.deleteBranch(name);
      if (!isActiveRepo(get, root)) return;
      set({ branches });
      // If the branch's commits were shown in the graph, stop requesting its now
      // non-existent ref (a bad revision would break the log query).
      const ref = localRef(name);
      if (get().visibleRefs.includes(ref)) {
        const next = get().visibleRefs.filter((r) => r !== ref);
        set({ visibleRefs: next });
        writeVisibleFor(root, next);
      }
      // A deleted branch's ref badge should disappear from the graph.
      await refreshRepoData(get, set, root);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async deleteRemoteBranch(remote: string, branch: string) {
    if (get().remoteBusy) return;
    const root = get().repo?.root;
    if (!root) return;
    set({ remoteBusy: true, busyAction: "remote" });
    try {
      const { branches } = await api.deleteRemoteBranch(remote, branch);
      if (!isActiveRepo(get, root)) return;
      set({ remoteBranches: branches });
      // Its commits can no longer be requested from the log — drop the ref.
      const ref = `refs/remotes/${remote}/${branch}`;
      if (get().visibleRefs.includes(ref)) {
        const next = get().visibleRefs.filter((r) => r !== ref);
        set({ visibleRefs: next });
        writeVisibleFor(root, next);
      }
      await refreshRepoData(get, set, root);
      if (!isActiveRepo(get, root)) return;
      raise(set, "notice", `Deleted ${remote}/${branch} on the remote.`);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    } finally {
      set({ remoteBusy: false, busyAction: null });
    }
  },

  async loadWorktrees() {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { worktrees } = await api.worktrees();
      if (get().repo?.root !== root) return;
      set({ worktrees });
    } catch {
      /* non-fatal */
    }
  },

  openWorktreeCreate() {
    set({ worktreeCreateOpen: true, selectedCommitHash: null, selectedFile: null });
    // Ensure the branch list (for the reference dropdown) is fresh.
    get().loadBranches();
  },
  closeWorktreeCreate() {
    set({ worktreeCreateOpen: false });
  },

  async createWorktree(path: string, ref: string, branch: string) {
    // Errors propagate so the create panel can show them inline.
    await api.addWorktree(path, ref, branch);
    set({ worktreeCreateOpen: false });
    raise(set, "notice", `Created worktree ${branch}.`);
    await refreshRepoData(get, set);
  },

  async openWorktree(path: string) {
    const state = get();
    // If the worktree is already open in a tab, just switch to it.
    const existing = state.tabs.find((t) => t.root === path);
    if (existing) {
      await get().selectTab(existing.id);
      return;
    }
    set({ opening: true, worktreeCreateOpen: false });
    try {
      // Re-point the CURRENT tab at the worktree's directory (a valid repo root
      // sharing the same .git), then load its data.
      const { repo } = await api.openRepo(path);
      const tabs = state.tabs.map((t) =>
        t.id === state.activeTabId
          ? { ...t, root: repo.root, name: basename(repo.root), branch: repo.branch }
          : t,
      );
      set({ tabs });
      persistTabs(tabs, state.activeTabId);
      await hydrateRepo(get, set, repo);
      await get().loadRecent();
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ opening: false });
    }
  },

  async removeWorktree(path: string) {
    try {
      await api.removeWorktree(path);
      raise(set, "notice", "Removed the worktree.");
      await refreshRepoData(get, set);
    } catch (e) {
      reportError(set, e);
    }
  },

  async pruneWorktrees() {
    try {
      await api.pruneWorktrees();
      raise(set, "notice", "Pruned stale worktrees.");
      await refreshRepoData(get, set);
    } catch (e) {
      reportError(set, e);
    }
  },

  async revealWorktree(path: string) {
    try {
      await api.revealWorktree(path);
    } catch (e) {
      reportError(set, e);
    }
  },

  async loadRemotes() {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { remotes } = await api.remotes();
      if (get().repo?.root !== root) return;
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
    try {
      const { remotes } = await api.removeRemote(name);
      set({ remotes });
      // Its remote-tracking branches should disappear from the sidebar/graph.
      await refreshRepoData(get, set);
    } catch (e) {
      reportError(set, e);
    }
  },

  async createGitHubRepo(opts) {
    set({ remoteBusy: true, busyAction: "remote" });
    try {
      const { repo, remotes } = await api.createGitHubRepo(opts);
      set({ remotes });
      await refreshRepoData(get, set);
      raise(set, "notice", `Created ${repo.fullName} and pushed ${get().repo?.branch ?? ""}.`);
      return repo.htmlUrl;
    } finally {
      set({ remoteBusy: false, busyAction: null });
    }
  },

  async push() {
    if (get().remoteBusy) return;
    await runPush(get, set, null);
  },

  async pull(remote?: string, branch?: string) {
    if (get().remoteBusy) return;
    const root = get().repo?.root;
    const startingBranch = get().repo?.branch;
    if (!root || !startingBranch) return;
    set({ remoteBusy: true, busyAction: "pull" });
    try {
      const { repo, merge, status } = await api.pull(remote, branch);
      if (!isActiveTarget(get, root, startingBranch)) return;
      if (repo) {
        set({ repo });
        syncActiveTab(get, set, repo);
      }
      applyMerge(get, set, merge, status);
      await refreshRepoData(get, set, root);
      if (!isActiveTarget(get, root, startingBranch)) return;
      if (merge.active) {
        set({ selectedCommitHash: null, selectedFile: null });
      } else {
        raise(set, "notice", "Pulled latest changes.");
      }
    } catch (e) {
      if (isActiveTarget(get, root, startingBranch)) reportError(set, e);
    } finally {
      set({ remoteBusy: false, busyAction: null });
    }
  },

  openPullRequest(branch?: string) {
    set({ prDialogOpen: true, prHeadBranch: branch ?? null });
  },
  closePullRequest() {
    set({ prDialogOpen: false, prHeadBranch: null });
  },

  async ensureBranchPushed(branch: string) {
    const root = get().repo?.root;
    if (!root) return { ok: false, reason: "The repository is no longer active." };
    const pushed = (name: string): boolean => {
      const b = get().branches.find((x) => x.name === name);
      return Boolean(b && b.upstream && !b.upstreamGone && b.ahead === 0);
    };
    if (pushed(branch)) return { ok: true };
    // Only the checked-out branch can be pushed from here (git pushes HEAD).
    if (branch !== get().repo?.branch) {
      return {
        ok: false,
        reason: `"${branch}" has commits that aren't on the remote. Check it out and push it first.`,
      };
    }
    const entry = get().branches.find((b) => b.name === branch);
    const ahead = entry?.ahead ?? 0;
    const detail = !entry?.upstream
      ? `"${branch}" isn't on the remote yet.`
      : `"${branch}" has ${ahead} unpushed commit${ahead === 1 ? "" : "s"}.`;
    const choice = await get().requestChoice(`${detail} Push it before opening the pull request?`, [
      { label: "Push and continue", value: "push", kind: "primary" },
      { label: "Cancel", value: "cancel", kind: "neutral" },
    ]);
    if (choice !== "push") return { ok: false };
    if (!isActiveTarget(get, root, branch)) {
      return { ok: false, reason: "The repository or branch changed before the push started." };
    }
    await get().push();
    if (!isActiveTarget(get, root, branch)) {
      return { ok: false, reason: "The repository or branch changed while pushing." };
    }
    return pushed(branch)
      ? { ok: true }
      : { ok: false, reason: `Couldn't push "${branch}" — resolve the push first, then try again.` };
  },

  async createPullRequest(input: CreatePrInput) {
    // Errors propagate so the dialog can show them inline.
    set({ remoteBusy: true, busyAction: "pr" });
    try {
      const created = await api.prCreate(input);
      // The PR lives on GitHub — open it so the user lands on the review page.
      // In the desktop app this has to leave the app entirely: a plain
      // window.open would be caught by the window-open handler anyway, and
      // without one it would put github.com inside a privileged window.
      openExternal(created.htmlUrl);
      await refreshRepoData(get, set);
      const warn = created.warnings.length > 0 ? ` — ${created.warnings.join("; ")}` : "";
      raise(set, "notice", `Opened pull request #${created.number}${warn}`);
      return created;
    } finally {
      set({ remoteBusy: false, busyAction: null });
    }
  },

  async loadMergeState() {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { merge } = await api.mergeState();
      if (get().repo?.root !== root) return;
      applyMerge(get, set, merge);
    } catch {
      /* non-fatal */
    }
  },

  async mergeBranch(name: string) {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { repo, merge, status } = await api.merge(name);
      if (!isActiveRepo(get, root)) return;
      if (repo) {
        set({ repo });
        syncActiveTab(get, set, repo);
      }
      applyMerge(get, set, merge, status);
      await refreshRepoData(get, set, root);
      if (!isActiveRepo(get, root)) return;
      if (merge.active) {
        // Conflicts — jump to the WIP/conflict view so the resolver is reachable.
        set({ selectedCommitHash: null, selectedFile: null });
      } else {
        raise(set, "notice", `Merged ${name} into ${get().repo?.branch ?? "the current branch"}.`);
      }
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async checkoutCommit(hash: string) {
    const root = get().repo?.root;
    if (!root) return;
    set({ commitMenu: null });
    try {
      const { repo, merge, status } = await api.checkoutCommit(hash);
      if (!isActiveRepo(get, root)) return;
      if (repo) {
        set({ repo });
        syncActiveTab(get, set, repo);
      }
      set({ selectedCommitHash: null, commitFiles: [], selectedFile: null });
      applyMerge(get, set, merge, status);
      await refreshRepoData(get, set, root);
      if (!isActiveRepo(get, root)) return;
      raise(set, "notice", `Checked out ${hash.slice(0, 7)} (detached HEAD).`);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async cherryPick(hash: string, noCommit: boolean) {
    const root = get().repo?.root;
    if (!root) return;
    set({ commitMenu: null });
    try {
      const { repo, merge, status } = await api.cherryPick(hash, noCommit);
      if (!isActiveRepo(get, root)) return;
      if (repo) {
        set({ repo });
        syncActiveTab(get, set, repo);
      }
      applyMerge(get, set, merge, status);
      await refreshRepoData(get, set, root);
      if (!isActiveRepo(get, root)) return;
      if (merge.active) {
        set({ selectedCommitHash: null, selectedFile: null });
      } else if (noCommit) {
        set({ selectedCommitHash: null, selectedFile: null });
        raise(set, "notice", `Cherry-picked ${hash.slice(0, 7)} — review the changes and commit.`);
      } else {
        raise(set, "notice", `Cherry-picked ${hash.slice(0, 7)}.`);
      }
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async abortMerge() {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { repo, merge, status } = await api.abortMerge();
      if (!isActiveRepo(get, root)) return;
      if (repo) {
        set({ repo });
        syncActiveTab(get, set, repo);
      }
      set({ mergeSeen: [], conflictPath: null, conflictData: null });
      applyMerge(get, set, merge, status);
      await refreshRepoData(get, set, root);
      if (!isActiveRepo(get, root)) return;
      raise(set, "notice", "Aborted — restored the pre-merge state.");
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async openConflict(path: string) {
    set({ conflictPath: path, conflictData: null, conflictLoading: true, selectedCommitHash: null });
    try {
      const data = await api.conflictFile(path);
      if (get().conflictPath === path) set({ conflictData: data });
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ conflictLoading: false });
    }
  },

  closeConflict() {
    set({ conflictPath: null, conflictData: null });
  },

  async saveResolution(path: string, content: string, resolved: boolean) {
    // Errors propagate so the resolver can show them inline.
    const { merge, status } = await api.resolveConflict(path, content, resolved);
    applyMerge(get, set, merge, status);
    if (resolved) raise(set, "notice", `Resolved ${path}.`);
  },

  async markAllResolved() {
    try {
      const { merge, status } = await api.resolveAll();
      applyMerge(get, set, merge, status);
    } catch (e) {
      reportError(set, e);
    }
  },

  async loadStashes() {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const { stashes } = await api.stashes();
      if (get().repo?.root !== root) return;
      set({ stashes });
      // The open stash may have just been popped, dropped, or left behind by a
      // repo switch — one guard here covers every way it can go.
      const open = get().selectedStashHash;
      if (open && !stashes.some((s) => s.hash === open)) {
        const file = get().selectedFile;
        set({
          selectedStashHash: null,
          commitFiles: [],
          selectedFile: file?.source === "commit" && file.hash === open ? null : file,
        });
      }
    } catch {
      /* non-fatal */
    }
  },

  async stash() {
    if (get().remoteBusy) return;
    set({ remoteBusy: true, busyAction: "stash" });
    try {
      const { stashed } = await api.stashPush();
      set({ selectedFile: null });
      await refreshRepoData(get, set);
      raise(set, "notice", stashed ? "Stashed your changes." : "Nothing to stash — working tree is clean.");
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ remoteBusy: false, busyAction: null });
    }
  },

  async stashPop(index = 0) {
    if (get().remoteBusy) return;
    set({ remoteBusy: true, busyAction: "pop", stashMenu: null });
    try {
      await api.stashPop(index);
      await refreshRepoData(get, set);
      raise(set, "notice", "Popped the stash.");
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ remoteBusy: false, busyAction: null });
    }
  },

  async stashApply(index: number) {
    if (get().remoteBusy) return;
    set({ remoteBusy: true, busyAction: "pop", stashMenu: null });
    try {
      await api.stashApply(index);
      await refreshRepoData(get, set);
      raise(set, "notice", "Applied the stash (kept it in the list).");
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ remoteBusy: false, busyAction: null });
    }
  },

  async stashDrop(index: number) {
    set({ stashMenu: null });
    try {
      await api.stashDrop(index);
      await refreshRepoData(get, set);
      raise(set, "notice", "Dropped the stash.");
    } catch (e) {
      reportError(set, e);
    }
  },

  openStashMenu(menu: StashMenu) {
    set({ stashMenu: menu, commitMenu: null });
  },
  closeStashMenu() {
    set({ stashMenu: null });
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
    // The connected account now provides the commit identity — refresh it.
    get().loadIdentity();
    return user;
  },

  async revokeGitHubToken() {
    try {
      const status = await api.githubRevoke();
      set({ githubStatus: status });
      // GitHub no longer overrides the commit identity — refresh it.
      get().loadIdentity();
    } catch (e) {
      reportError(set, e);
    }
  },

  async loadIdentity() {
    try {
      const identity = await api.identity();
      set({ identity });
    } catch {
      /* non-fatal */
    }
  },

  async saveIdentity(name: string, email: string) {
    // Errors propagate so the dialog can show them inline.
    const identity = await api.setIdentity(name, email);
    set({ identity });
  },

  async clearIdentity() {
    try {
      const identity = await api.clearIdentity();
      set({ identity });
    } catch (e) {
      reportError(set, e);
    }
  },

  openIdentityDialog() {
    set({ identityDialogOpen: true });
    get().loadIdentity();
  },
  closeIdentityDialog() {
    set({ identityDialogOpen: false });
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

  toggleTerminal() {
    set({ terminalOpen: !get().terminalOpen });
  },
  setTerminalHeight(px: number) {
    const clamped = Math.max(MIN_TERMINAL_H, Math.min(px, Math.round(window.innerHeight * 0.8)));
    try {
      localStorage.setItem(TERMINAL_H_KEY, String(clamped));
    } catch {
      /* ignore storage failures */
    }
    set({ terminalHeight: clamped });
  },

  requestConfirm(message: string, confirmLabel = "Confirm") {
    return get()
      .requestChoice(message, [
        { label: confirmLabel, value: "confirm", kind: "danger" },
        { label: "Cancel", value: "cancel", kind: "neutral" },
      ])
      .then((v) => v === "confirm");
  },
  requestChoice(message: string, buttons: ConfirmButton[], options?: { checkbox?: string }) {
    return new Promise<string | null>((resolve) => {
      confirmResolver = resolve;
      set({ confirm: { message, buttons, checkbox: options?.checkbox }, confirmCheckbox: false });
    });
  },
  resolveConfirm(value: string | null) {
    const resolve = confirmResolver;
    confirmResolver = null;
    // Leave confirmCheckbox as-is so the caller can read it right after awaiting.
    set({ confirm: null });
    resolve?.(value);
  },
  setConfirmCheckbox(checked: boolean) {
    set({ confirmCheckbox: checked });
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
    const root = get().repo?.root;
    if (!root) return;
    set({ branchDialogHash: null, commitMenu: null });
    try {
      const { repo } = await api.createBranch(name, hash);
      if (!isActiveRepo(get, root)) return;
      set({ repo });
      syncActiveTab(get, set, repo);
      await refreshRepoData(get, set, root);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async resetToCommit(hash: string, mode: ResetMode) {
    const root = get().repo?.root;
    if (!root) return;
    set({ commitMenu: null });
    try {
      const { repo } = await api.reset(hash, mode);
      if (!isActiveRepo(get, root)) return;
      set({ repo, selectedCommitHash: null, commitFiles: [], selectedFile: null });
      await refreshRepoData(get, set, root);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async revertCommit(hash: string) {
    const root = get().repo?.root;
    if (!root) return;
    set({ commitMenu: null });
    try {
      const { repo, merge, status } = await api.revert(hash);
      if (!isActiveRepo(get, root)) return;
      if (repo) set({ repo });
      set({ selectedCommitHash: null, commitFiles: [], selectedFile: null });
      applyMerge(get, set, merge, status);
      await refreshRepoData(get, set, root);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async refreshStatus() {
    const root = get().repo?.root;
    if (!root) return;
    set({ loadingStatus: true });
    try {
      const status = await api.status();
      if (get().repo?.root !== root) return;
      set({ status });
    } catch (e) {
      if (get().repo?.root === root) reportError(set, e);
    } finally {
      if (get().repo?.root === root) set({ loadingStatus: false });
    }
  },

  async refreshAll() {
    const root = get().repo?.root;
    if (!root || get().opening) return;
    try {
      // Git may have been changed by the built-in terminal or another client.
      // Refresh the branch/HEAD metadata before the derived lists so the tab
      // label and active repository stay in sync with the data below them.
      const { repo } = await api.currentRepo();
      // A rapid tab switch can finish while this request is in flight. Never
      // apply the previous repository's response to the newly active tab.
      if (!repo || get().repo?.root !== root) return;
      set({ repo });
      syncActiveTab(get, set, repo);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
      return;
    }
    await refreshRepoData(get, set, root);
  },

  async stage(paths: string[]) {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const status = await api.stage(paths);
      if (!isActiveRepo(get, root)) return;
      set({ status });
      syncSelectedWithStatus(get, set, status);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async stageAll() {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const status = await api.stageAll();
      if (!isActiveRepo(get, root)) return;
      set({ status });
      syncSelectedWithStatus(get, set, status);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async unstage(paths: string[]) {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const status = await api.unstage(paths);
      if (!isActiveRepo(get, root)) return;
      set({ status });
      syncSelectedWithStatus(get, set, status);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async discardAll() {
    const root = get().repo?.root;
    if (!root) return;
    try {
      const status = await api.discardAll();
      if (!isActiveRepo(get, root)) return;
      set({ status, selectedFile: null });
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async discardPaths(paths: string[]) {
    const root = get().repo?.root;
    if (!root) return;
    set({ changesMenu: null });
    try {
      const status = await api.discardPaths(paths);
      if (!isActiveRepo(get, root)) return;
      set({ status, selectedFile: null });
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async deleteFile(path: string) {
    const root = get().repo?.root;
    if (!root) return;
    set({ changesMenu: null });
    try {
      const status = await api.deleteFile(path);
      if (!isActiveRepo(get, root)) return;
      set({ status, selectedFile: null });
      raise(set, "notice", `Deleted ${path}.`);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
    }
  },

  async revealPath(path: string) {
    set({ changesMenu: null });
    try {
      await api.reveal(path);
    } catch (e) {
      reportError(set, e);
    }
  },

  openChangesMenu(menu: ChangesMenu) {
    set({ changesMenu: menu, commitMenu: null, stashMenu: null });
  },
  closeChangesMenu() {
    set({ changesMenu: null });
  },

  async commit(title: string, description: string, amend: boolean) {
    const root = get().repo?.root;
    if (!root) return;
    set({ committing: true });
    try {
      const { repo, status } = await api.commit(title, description, amend);
      if (!isActiveRepo(get, root)) return;
      set({ ...(repo ? { repo } : {}), status, selectedFile: null });
      if (repo) syncActiveTab(get, set, repo);
      await refreshRepoData(get, set, root);
    } catch (e) {
      if (isActiveRepo(get, root)) reportError(set, e);
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

  setError(msg: string) {
    raise(set, "error", msg);
  },

  setNotice(msg: string) {
    raise(set, "notice", msg);
  },

  dismissToast(id: number) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

type StoreGet = () => AppState;
type StoreSet = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void;

function isActiveRepo(get: StoreGet, root: string): boolean {
  return get().repo?.root === root;
}

function isActiveTarget(get: StoreGet, root: string, branch: string): boolean {
  const repo = get().repo;
  return repo?.root === root && repo.branch === branch;
}

/**
 * Re-sync every piece of repo data that a mutation could have changed: commits,
 * status, local/remote branches, remotes, stashes, merge state, and worktrees.
 * This is the single "everything is fresh now" path — every mutating action ends
 * with it, so no action has to remember which specific lists it touched. It
 * preserves scroll (reloads only as many commits as are paged in) and doesn't
 * disturb the current selection. Read-only/selection actions skip it.
 */
async function refreshRepoData(
  get: StoreGet,
  set: StoreSet,
  expectedRoot = get().repo?.root,
): Promise<void> {
  if (!expectedRoot || !isActiveRepo(get, expectedRoot)) return;
  // Bump the tick first so an open diff refetches alongside the lists.
  set({ refreshTick: get().refreshTick + 1 });
  // Refresh remote branches first so any deleted refs are pruned from the
  // visible set before we query the log with them.
  await get().loadRemoteBranches();
  // A tab switch while the first refresh was in flight changes the API's
  // request target. Stop here instead of issuing the rest against another repo.
  if (!isActiveRepo(get, expectedRoot)) return;
  // Reload as many commits as are currently paged in, so a deep scroll position
  // survives the refresh (server caps the page at 1000).
  const count = Math.min(1000, Math.max(PAGE, get().commits.length));
  const commitsPromise = api
    .commits(0, count, get().visibleRefs)
    .then(({ commits, hasMore }) => {
      if (isActiveRepo(get, expectedRoot)) set({ commits, hasMore });
    })
    .catch((e) => {
      if (isActiveRepo(get, expectedRoot)) reportError(set, e);
    });
  await Promise.all([
    commitsPromise,
    get().refreshStatus(),
    get().loadBranches(),
    get().loadRemotes(),
    get().loadStashes(),
    get().loadMergeState(),
    get().loadWorktrees(),
  ]);
}

const FORCE_PUSH_SKIP_KEY = "gwui.skipForcePushConfirm";

interface PushBinding {
  root: string;
  branch: string;
}

/**
 * Push the current branch, handling a non-fast-forward rejection like GitKraken:
 * whenever the local and remote tips have diverged (amend, rebase, reset, or a
 * remote that moved), offer Pull (to integrate the remote's work) or one of the
 * two confirmed force modes — see `promptRejectedPush`.
 */
async function runPush(
  get: StoreGet,
  set: StoreSet,
  force: PushForce | null,
  expected?: PushBinding,
): Promise<void> {
  const current = get().repo;
  const binding: PushBinding | null = expected ?? (
    current ? { root: current.root, branch: current.branch } : null
  );
  if (!binding || !isActiveTarget(get, binding.root, binding.branch)) return;
  set({ remoteBusy: true, busyAction: "push" });
  let rejected: {
    root: string;
    branch: string;
    upstream: string | null;
    remote?: string;
    remoteBranch?: string;
  } | null = null;
  try {
    const res = await api.push(force);
    if (!isActiveTarget(get, binding.root, binding.branch)) return;
    if (res.rejected && !force) {
      rejected = {
        root: binding.root,
        branch: res.branch,
        upstream: res.upstream ?? null,
        remote: res.remote,
        remoteBranch: res.remoteBranch,
      };
    } else {
      await refreshRepoData(get, set, binding.root);
      if (!isActiveTarget(get, binding.root, binding.branch)) return;
      raise(set, "notice", force ? `Force-pushed ${res.branch}.` : `Pushed ${res.branch}.`);
    }
  } catch (e) {
    if (isActiveTarget(get, binding.root, binding.branch)) reportError(set, e);
  } finally {
    set({ remoteBusy: false, busyAction: null });
  }
  // Prompt only after clearing remoteBusy so the follow-up Pull/Force can run.
  if (rejected && isActiveTarget(get, rejected.root, rejected.branch)) {
    await promptRejectedPush(get, set, rejected);
  }
}

/**
 * The banner shown when a push is rejected. Both force modes are offered so the
 * choice is explicit: with-lease is the safe default (it still refuses when the
 * remote holds commits we never fetched), while the bare force is the escape
 * hatch for a locally rewritten history whose lease can't be verified. Each is
 * confirmed before it runs.
 */
async function promptRejectedPush(
  get: StoreGet,
  set: StoreSet,
  rejected: {
    root: string;
    branch: string;
    upstream: string | null;
    remote?: string;
    remoteBranch?: string;
  },
): Promise<void> {
  const target = rejected.upstream ? `'refs/remotes/${rejected.upstream}'` : "the remote";
  const choice = await get().requestChoice(
    `'refs/heads/${rejected.branch}' has diverged from ${target}. Pull to integrate the remote's work, or force push to overwrite it.`,
    [
      { label: "Pull (fast-forward if possible)", value: "pull", kind: "primary" },
      { label: "Force Push (with lease)", value: "lease", kind: "danger" },
      { label: "Force Push (no lease)", value: "force", kind: "danger" },
      { label: "Cancel", value: "cancel", kind: "neutral" },
    ],
  );
  // The confirmation belongs to the exact repo/branch whose push was rejected.
  // Switching tabs or branches while it is open must cancel every follow-up.
  if (!isActiveTarget(get, rejected.root, rejected.branch)) return;
  if (choice === "pull") {
    await get().pull(rejected.remote, rejected.remoteBranch);
  } else if (choice === "lease" || choice === "force") {
    if (await confirmForcePush(get, choice)) {
      if (!isActiveTarget(get, rejected.root, rejected.branch)) return;
      await runPush(get, set, choice, { root: rejected.root, branch: rejected.branch });
    }
  }
}

/**
 * Confirm a destructive force push. The with-lease mode honors a saved "Don't
 * ask again" choice; the bare force always asks, because it's the one mode that
 * can overwrite commits nobody here has ever seen.
 */
async function confirmForcePush(get: StoreGet, mode: PushForce): Promise<boolean> {
  const bare = mode === "force";
  if (!bare) {
    try {
      if (localStorage.getItem(FORCE_PUSH_SKIP_KEY) === "1") return true;
    } catch {
      /* ignore storage failures */
    }
  }
  const value = await get().requestChoice(
    bare
      ? "Force push with no lease overwrites the remote branch unconditionally — including commits you've never fetched. This cannot be undone. Are you sure?"
      : "Force push is a destructive action and cannot be undone. Are you sure?",
    [
      {
        label: bare ? "Force Push (no lease)" : "Force Push (with lease)",
        value: "force",
        kind: "danger",
      },
      { label: "Cancel", value: "cancel", kind: "neutral" },
    ],
    bare ? undefined : { checkbox: "Don't ask again" },
  );
  if (value !== "force") return false;
  if (!bare && get().confirmCheckbox) {
    try {
      localStorage.setItem(FORCE_PUSH_SKIP_KEY, "1");
    } catch {
      /* ignore storage failures */
    }
  }
  return true;
}

/** Reset the active-repo view to the empty picker (no repo targeted). */
function showPicker(set: StoreSet): void {
  setRequestRepoRoot(null);
  set({
    repo: null,
    commits: [],
    hasMore: false,
    selectedCommitHash: null,
    commitFiles: [],
    selectedFile: null,
    status: EMPTY_STATUS,
    branches: [],
    remotes: [],
    remoteBranches: [],
    worktrees: [],
    worktreeCreateOpen: false,
    visibleRefs: [],
    stashes: [],
    commitMenu: null,
    stashMenu: null,
    mergeState: null,
    mergeSeen: [],
    conflictPath: null,
    conflictData: null,
    loadingCommits: false,
    loadingStatus: false,
  });
}

/** Point the API at `info` and load its commits, status, branches, remotes, stashes. */
async function hydrateRepo(get: StoreGet, set: StoreSet, info: RepoInfo): Promise<void> {
  setRequestRepoRoot(info.root);
  set({
    repo: info,
    commits: [],
    hasMore: false,
    selectedCommitHash: null,
    commitFiles: [],
    selectedFile: null,
    status: EMPTY_STATUS,
    branches: [],
    remotes: [],
    remoteBranches: [],
    worktrees: [],
    worktreeCreateOpen: false,
    visibleRefs: [],
    stashes: [],
    commitMenu: null,
    stashMenu: null,
    mergeState: null,
    mergeSeen: [],
    conflictPath: null,
    conflictData: null,
    loadingCommits: false,
    loadingStatus: false,
  });
  // Load the ref lists first so we can resolve the default visible set and query
  // the log with valid refs.
  await Promise.all([get().loadRemoteBranches(), get().loadBranches()]);
  if (get().repo?.root !== info.root) return;
  set({ visibleRefs: resolveVisibleRefs(get(), info.root) });
  writeVisibleFor(info.root, get().visibleRefs);
  await Promise.all([
    get().loadCommits(true),
    get().refreshStatus(),
    get().loadRemotes(),
    get().loadStashes(),
    get().loadMergeState(),
    get().loadWorktrees(),
  ]);
}

/**
 * Fold a server merge-state response into the store: track which paths have been
 * seen conflicted (so resolved ones can be listed), apply the fresh status, and
 * close the resolver when its file is no longer conflicted (or the op ended).
 */
function applyMerge(
  get: StoreGet,
  set: StoreSet,
  merge: MergeState,
  status?: StatusResult,
): void {
  const state = get();
  const active = merge.active;
  const seen = active
    ? Array.from(new Set([...state.mergeSeen, ...merge.conflicted]))
    : [];
  const resolverStale =
    !active || (state.conflictPath != null && !merge.conflicted.includes(state.conflictPath));
  set({
    mergeState: active ? merge : null,
    mergeSeen: seen,
    ...(status ? { status } : {}),
    ...(resolverStale ? { conflictPath: null, conflictData: null } : {}),
  });
}

/**
 * The set of remote refs to show in the log: the repo's saved choice, or — on
 * first open — the current branch's upstream so its commits read as "shown"
 * rather than hidden. Always pruned to refs that still exist.
 */
function resolveVisibleRefs(state: AppState, root: string): string[] {
  const exists = (ref: string) =>
    state.remoteBranches.some((b) => b.ref === ref) ||
    state.branches.some((b) => localRef(b.name) === ref);
  const stored = readVisibleFor(root);
  if (stored !== null) return stored.filter(exists);
  const upstream = state.branches.find((b) => b.current)?.upstream ?? null;
  const upstreamRef = upstream
    ? state.remoteBranches.find((b) => b.name === upstream)?.ref ?? null
    : null;
  return upstreamRef ? [upstreamRef] : [];
}

/**
 * Bring a freshly opened/cloned repo into the workspace: switch to its existing
 * tab if one is open, else fill the active empty tab or append a new one, then
 * load its data.
 */
async function adoptRepo(get: StoreGet, set: StoreSet, info: RepoInfo): Promise<void> {
  const state = get();
  const name = basename(info.root);
  const existing = state.tabs.find((t) => t.root === info.root);
  let tabs = state.tabs.map((t) => ({ ...t }));
  let activeTabId: string;
  if (existing) {
    const e = tabs.find((t) => t.id === existing.id)!;
    e.branch = info.branch;
    e.name = name;
    activeTabId = e.id;
  } else {
    const active = tabs.find((t) => t.id === state.activeTabId);
    if (active && active.root === null) {
      active.root = info.root;
      active.name = name;
      active.branch = info.branch;
      activeTabId = active.id;
    } else {
      const nt: RepoTab = { id: uid(), root: info.root, name, branch: info.branch };
      tabs = [...tabs, nt];
      activeTabId = nt.id;
    }
  }
  set({ tabs, activeTabId });
  persistTabs(tabs, activeTabId);
  await hydrateRepo(get, set, info);
}

/** Keep the active tab's branch/name label in sync with a server repo response. */
function syncActiveTab(get: StoreGet, set: StoreSet, info: RepoInfo): void {
  const tabs = get().tabs.map((t) =>
    t.root === info.root ? { ...t, branch: info.branch, name: basename(info.root) } : t,
  );
  set({ tabs });
  persistTabs(tabs, get().activeTabId);
}

/** Keep an open working-file diff attached to its fresh status entry after staging changes. */
function syncSelectedWithStatus(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  status: StatusResult,
): void {
  const sel = get().selectedFile;
  if (!sel || sel.source === "commit") return;
  const preferred = sel.source === "staged" ? status.staged : status.unstaged;
  const other = sel.source === "staged" ? status.unstaged : status.staged;
  const fresh =
    preferred.find((file) => file.path === sel.path) ??
    other.find((file) => file.path === sel.path) ??
    preferred.find((file) => file.oldPath === sel.path) ??
    other.find((file) => file.oldPath === sel.path);
  if (!fresh) {
    // Staging can consolidate an old deletion + new addition into a rename; an
    // external edit can also remove the selected entry while the request runs.
    set({ selectedFile: null });
    return;
  }
  set({
    selectedFile: {
      ...sel,
      path: fresh.path,
      oldPath: fresh.oldPath,
      source: fresh.staged ? "staged" : "unstaged",
      staged: fresh.staged,
      status: fresh.status,
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
function reportError(set: StoreSet, e: unknown): void {
  if (e instanceof AuthError) {
    set({ authState: "login" });
    return;
  }
  raise(set, "error", errMsg(e));
}
