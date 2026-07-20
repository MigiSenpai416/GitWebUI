import { create } from "zustand";
import { api, AuthError, setRequestRepoRoot } from "../api/client";
import type {
  Branch,
  Commit,
  CommitFile,
  ConflictFileData,
  GitHubStatus,
  GitHubUser,
  IdentityInfo,
  MergeState,
  RepoInfo,
  Remote,
  RemoteBranch,
  SelectedFile,
  StashEntry,
  StatusResult,
} from "../types";

const PAGE = 150;
const SIDEBAR_KEY = "gwui.sidebarCollapsed";
const TABS_KEY = "gwui.tabs";
const VISIBLE_KEY = "gwui.visibleRefs";

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
}

interface AppState {
  authState: AuthState;

  /** Open workspace tabs and which one is active. */
  tabs: RepoTab[];
  activeTabId: string | null;
  cloneDialogOpen: boolean;

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
  /** Extra remote branch refs (beyond HEAD) whose commits show in the log. */
  visibleRefs: string[];
  stashes: StashEntry[];
  githubStatus: GitHubStatus | null;
  /** A push/pull/create-remote network op is in flight. */
  remoteBusy: boolean;
  addRemoteOpen: boolean;
  githubDialogOpen: boolean;
  identityDialogOpen: boolean;
  identity: IdentityInfo | null;

  /** Whether the LOCAL/REMOTE left rail is collapsed (persisted). */
  sidebarCollapsed: boolean;

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
  closeRepo: () => void;

  /** Tabs. */
  newTab: () => void;
  selectTab: (id: string) => Promise<void>;
  closeTab: (id: string) => void;
  openCloneDialog: () => void;
  closeCloneDialog: () => void;

  loadCommits: (reset: boolean) => Promise<void>;
  selectCommit: (hash: string | null) => Promise<void>;

  loadBranches: () => Promise<void>;
  loadRemoteBranches: () => Promise<void>;
  toggleBranchVisibility: (ref: string) => void;
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

  loadMergeState: () => Promise<void>;
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

  /** Show a two-button confirm banner; resolves true if confirmed, false otherwise. */
  requestConfirm: (message: string, confirmLabel?: string) => Promise<boolean>;
  /** Show a banner with custom buttons; resolves the chosen value, or null if dismissed. */
  requestChoice: (message: string, buttons: ConfirmButton[]) => Promise<string | null>;
  resolveConfirm: (value: string | null) => void;

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
  setError: (msg: string | null) => void;
  setNotice: (msg: string | null) => void;
}

const EMPTY_STATUS: StatusResult = { staged: [], unstaged: [] };

// Holds the resolver for the currently-open confirmation banner, if any.
let confirmResolver: ((value: string | null) => void) | null = null;

const initialTabs = readTabs();

export const useStore = create<AppState>((set, get) => ({
  authState: "loading",

  tabs: initialTabs.tabs,
  activeTabId: initialTabs.activeTabId,
  cloneDialogOpen: false,

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

  mergeState: null,
  mergeSeen: [],
  conflictPath: null,
  conflictData: null,
  conflictLoading: false,

  branches: [],
  remotes: [],
  remoteBranches: [],
  visibleRefs: [],
  stashes: [],
  githubStatus: null,
  remoteBusy: false,
  addRemoteOpen: false,
  githubDialogOpen: false,
  identityDialogOpen: false,
  identity: null,

  sidebarCollapsed: readSidebarCollapsed(),

  selectedFile: null,
  viewMode: "diff",
  fileLayout: "tree",

  commitMenu: null,
  stashMenu: null,
  changesMenu: null,
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
    set({ opening: true, error: null });
    try {
      const { repo } = await api.openRepo(path);
      await adoptRepo(get, set, repo);
      await get().loadRecent();
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ opening: false });
    }
  },

  async cloneRepo(dir: string, url: string) {
    // Errors propagate so the Clone dialog can show them inline.
    const { repo } = await api.cloneRepo(dir, url);
    await adoptRepo(get, set, repo);
    await get().loadRecent();
  },

  newTab() {
    const t = pickerTab();
    const tabs = [...get().tabs, t];
    set({ tabs, activeTabId: t.id });
    persistTabs(tabs, t.id);
    showPicker(set);
  },

  async selectTab(id: string) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    set({ activeTabId: id, error: null });
    if (!tab.root) {
      persistTabs(get().tabs, id);
      showPicker(set);
      return;
    }
    set({ opening: true });
    try {
      // Re-open on the backend: idempotent, and re-registers the repo after a
      // server restart so data requests for this tab keep working.
      const { repo } = await api.openRepo(tab.root);
      const tabs = get().tabs.map((t) =>
        t.id === id ? { ...t, branch: repo.branch, name: basename(repo.root) } : t,
      );
      set({ tabs });
      persistTabs(tabs, id);
      await hydrateRepo(get, set, repo);
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ opening: false });
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

  // Turn the active tab back into an empty picker ("Open a different repository").
  closeRepo() {
    const state = get();
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    if (active?.root) api.closeRepo(active.root).catch(() => undefined);
    const tabs = state.tabs.map((t) =>
      t.id === state.activeTabId ? { ...t, root: null, name: "New Tab", branch: "" } : t,
    );
    set({ tabs });
    persistTabs(tabs, state.activeTabId);
    showPicker(set);
  },

  async loadCommits(reset: boolean) {
    if (get().loadingCommits) return;
    const skip = reset ? 0 : get().commits.length;
    set({ loadingCommits: true });
    try {
      const { commits, hasMore } = await api.commits(skip, PAGE, get().visibleRefs);
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

  async loadRemoteBranches() {
    try {
      const { branches } = await api.remoteBranches();
      set({ remoteBranches: branches });
      // Drop any visible refs whose branch no longer exists on the remote.
      const cur = get().visibleRefs;
      const pruned = cur.filter((ref) => branches.some((b) => b.ref === ref));
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
    set({ error: null });
    try {
      const { repo } = await api.checkout(branch);
      set({
        repo,
        selectedCommitHash: null,
        commitFiles: [],
        selectedFile: null,
      });
      syncActiveTab(get, set, repo);
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
      const { merge, status } = await api.pull();
      applyMerge(get, set, merge, status);
      await Promise.all([get().loadCommits(true), get().loadBranches()]);
      if (merge.active) {
        set({ selectedCommitHash: null, selectedFile: null });
      } else {
        set({ notice: "Pulled latest changes." });
      }
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ remoteBusy: false });
    }
  },

  async loadMergeState() {
    try {
      const { merge } = await api.mergeState();
      applyMerge(get, set, merge);
    } catch {
      /* non-fatal */
    }
  },

  async checkoutCommit(hash: string) {
    set({ error: null, commitMenu: null });
    try {
      const { repo, merge, status } = await api.checkoutCommit(hash);
      if (repo) {
        set({ repo });
        syncActiveTab(get, set, repo);
      }
      set({ selectedCommitHash: null, commitFiles: [], selectedFile: null });
      applyMerge(get, set, merge, status);
      await Promise.all([get().loadCommits(true), get().loadBranches()]);
      set({ notice: `Checked out ${hash.slice(0, 7)} (detached HEAD).` });
    } catch (e) {
      reportError(set, e);
    }
  },

  async cherryPick(hash: string, noCommit: boolean) {
    set({ error: null, commitMenu: null });
    try {
      const { repo, merge, status } = await api.cherryPick(hash, noCommit);
      if (repo) {
        set({ repo });
        syncActiveTab(get, set, repo);
      }
      applyMerge(get, set, merge, status);
      await Promise.all([get().loadCommits(true), get().loadBranches()]);
      if (merge.active) {
        set({ selectedCommitHash: null, selectedFile: null });
      } else if (noCommit) {
        set({
          selectedCommitHash: null,
          selectedFile: null,
          notice: `Cherry-picked ${hash.slice(0, 7)} — review the changes and commit.`,
        });
      } else {
        set({ notice: `Cherry-picked ${hash.slice(0, 7)}.` });
      }
    } catch (e) {
      reportError(set, e);
    }
  },

  async abortMerge() {
    set({ error: null });
    try {
      const { repo, merge, status } = await api.abortMerge();
      if (repo) {
        set({ repo });
        syncActiveTab(get, set, repo);
      }
      set({ mergeSeen: [], conflictPath: null, conflictData: null });
      applyMerge(get, set, merge, status);
      await Promise.all([get().loadCommits(true), get().loadBranches()]);
      set({ notice: "Aborted — restored the pre-merge state." });
    } catch (e) {
      reportError(set, e);
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
    if (resolved) set({ notice: `Resolved ${path}.` });
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
    try {
      const { stashes } = await api.stashes();
      set({ stashes });
    } catch {
      /* non-fatal */
    }
  },

  async stash() {
    if (get().remoteBusy) return;
    set({ remoteBusy: true, error: null });
    try {
      const { stashed, status, stashes } = await api.stashPush();
      set({ status, stashes, selectedFile: null });
      set({ notice: stashed ? "Stashed your changes." : "Nothing to stash — working tree is clean." });
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ remoteBusy: false });
    }
  },

  async stashPop(index = 0) {
    if (get().remoteBusy) return;
    set({ remoteBusy: true, error: null, stashMenu: null });
    try {
      const { status, stashes } = await api.stashPop(index);
      set({ status, stashes });
      set({ notice: "Popped the stash." });
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ remoteBusy: false });
    }
  },

  async stashApply(index: number) {
    if (get().remoteBusy) return;
    set({ remoteBusy: true, error: null, stashMenu: null });
    try {
      const { status, stashes } = await api.stashApply(index);
      set({ status, stashes });
      set({ notice: "Applied the stash (kept it in the list)." });
    } catch (e) {
      reportError(set, e);
    } finally {
      set({ remoteBusy: false });
    }
  },

  async stashDrop(index: number) {
    set({ error: null, stashMenu: null });
    try {
      const { stashes } = await api.stashDrop(index);
      set({ stashes });
      set({ notice: "Dropped the stash." });
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
    set({ error: null });
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
    set({ error: null });
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

  requestConfirm(message: string, confirmLabel = "Confirm") {
    return get()
      .requestChoice(message, [
        { label: confirmLabel, value: "confirm", kind: "danger" },
        { label: "Cancel", value: "cancel", kind: "neutral" },
      ])
      .then((v) => v === "confirm");
  },
  requestChoice(message: string, buttons: ConfirmButton[]) {
    return new Promise<string | null>((resolve) => {
      confirmResolver = resolve;
      set({ confirm: { message, buttons } });
    });
  },
  resolveConfirm(value: string | null) {
    const resolve = confirmResolver;
    confirmResolver = null;
    set({ confirm: null });
    resolve?.(value);
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
      syncActiveTab(get, set, repo);
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
      const { repo, merge, status } = await api.revert(hash);
      if (repo) set({ repo });
      set({ selectedCommitHash: null, commitFiles: [], selectedFile: null });
      applyMerge(get, set, merge, status);
      await Promise.all([get().loadCommits(true), get().loadBranches()]);
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
    // Refresh remote branches first so any deleted refs are pruned from the
    // visible set before we query the log with them.
    await s.loadRemoteBranches();
    // Reload as many commits as are currently paged in, so a deep scroll
    // position survives the refresh (server caps the page at 1000).
    const count = Math.min(1000, Math.max(PAGE, s.commits.length));
    const commitsPromise = api
      .commits(0, count, get().visibleRefs)
      .then(({ commits, hasMore }) => set({ commits, hasMore }))
      .catch((e) => reportError(set, e));
    // A selected commit's file list is immutable, so it needs no reload.
    await Promise.all([
      commitsPromise,
      s.refreshStatus(),
      s.loadBranches(),
      s.loadRemotes(),
      s.loadStashes(),
      s.loadMergeState(),
    ]);
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

  async discardPaths(paths: string[]) {
    set({ changesMenu: null });
    try {
      const status = await api.discardPaths(paths);
      set({ status, selectedFile: null });
    } catch (e) {
      reportError(set, e);
    }
  },

  async deleteFile(path: string) {
    set({ changesMenu: null });
    try {
      const status = await api.deleteFile(path);
      set({ status, selectedFile: null });
      set({ notice: `Deleted ${path}.` });
    } catch (e) {
      reportError(set, e);
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
    set({ committing: true, error: null });
    try {
      const { status } = await api.commit(title, description, amend);
      set({ status, selectedFile: null });
      await Promise.all([get().loadCommits(true), get().loadBranches(), get().loadMergeState()]);
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

type StoreGet = () => AppState;
type StoreSet = (partial: Partial<AppState>) => void;

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
    visibleRefs: [],
    stashes: [],
    commitMenu: null,
    stashMenu: null,
    mergeState: null,
    mergeSeen: [],
    conflictPath: null,
    conflictData: null,
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
    visibleRefs: [],
    stashes: [],
    commitMenu: null,
    stashMenu: null,
    mergeState: null,
    mergeSeen: [],
    conflictPath: null,
    conflictData: null,
  });
  // Load the ref lists first so we can resolve the default visible set and query
  // the log with valid refs.
  await Promise.all([get().loadRemoteBranches(), get().loadBranches()]);
  set({ visibleRefs: resolveVisibleRefs(get(), info.root) });
  writeVisibleFor(info.root, get().visibleRefs);
  await Promise.all([
    get().loadCommits(true),
    get().refreshStatus(),
    get().loadRemotes(),
    get().loadStashes(),
    get().loadMergeState(),
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
  const exists = (ref: string) => state.remoteBranches.some((b) => b.ref === ref);
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
