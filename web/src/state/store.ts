import { create } from "zustand";
import { api } from "../api/client";
import type {
  Branch,
  Commit,
  CommitFile,
  RepoInfo,
  SelectedFile,
  StatusResult,
} from "../types";

const PAGE = 150;

type ViewMode = "diff" | "file";
/** How the changes sidebar groups files. */
export type FileLayout = "path" | "tree";
export type ResetMode = "hard" | "soft" | "mixed";

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
  loadRecent: () => Promise<void>;
  openRepo: (path: string) => Promise<void>;
  closeRepo: () => void;

  loadCommits: (reset: boolean) => Promise<void>;
  selectCommit: (hash: string | null) => Promise<void>;

  loadBranches: () => Promise<void>;
  checkout: (branch: string) => Promise<void>;
  deleteBranch: (name: string) => Promise<void>;

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

  selectedFile: null,
  viewMode: "diff",
  fileLayout: "tree",

  commitMenu: null,
  branchDialogHash: null,
  refreshTick: 0,
  confirm: null,

  async init() {
    await get().loadRecent();
    try {
      const { repo } = await api.currentRepo();
      if (repo) {
        set({ repo });
        await Promise.all([get().loadCommits(true), get().refreshStatus(), get().loadBranches()]);
      }
    } catch (e) {
      set({ error: errMsg(e) });
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
      await Promise.all([get().loadCommits(true), get().refreshStatus(), get().loadBranches()]);
    } catch (e) {
      set({ error: errMsg(e) });
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
      set({ error: errMsg(e) });
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
      set({ error: errMsg(e) });
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
      set({ error: errMsg(e) });
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
      set({ error: errMsg(e) });
    }
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
      set({ error: errMsg(e) });
    }
  },

  async resetToCommit(hash: string, mode: ResetMode) {
    set({ error: null, commitMenu: null });
    try {
      const { repo } = await api.reset(hash, mode);
      set({ repo, selectedCommitHash: null, commitFiles: [], selectedFile: null });
      await Promise.all([get().loadCommits(true), get().refreshStatus(), get().loadBranches()]);
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  async revertCommit(hash: string) {
    set({ error: null, commitMenu: null });
    try {
      const { repo } = await api.revert(hash);
      set({ repo, selectedCommitHash: null, commitFiles: [], selectedFile: null });
      await Promise.all([get().loadCommits(true), get().refreshStatus(), get().loadBranches()]);
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  async refreshStatus() {
    set({ loadingStatus: true });
    try {
      const status = await api.status();
      set({ status });
    } catch (e) {
      set({ error: errMsg(e) });
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
      .catch((e) => set({ error: errMsg(e) }));
    // A selected commit's file list is immutable, so it needs no reload.
    await Promise.all([commitsPromise, s.refreshStatus(), s.loadBranches()]);
  },

  async stage(paths: string[]) {
    try {
      const status = await api.stage(paths);
      set({ status });
      syncSelectedAfterStage(get, set, paths, true);
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  async stageAll() {
    try {
      const status = await api.stageAll();
      set({ status });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  async unstage(paths: string[]) {
    try {
      const status = await api.unstage(paths);
      set({ status });
      syncSelectedAfterStage(get, set, paths, false);
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  async discardAll() {
    try {
      const status = await api.discardAll();
      set({ status, selectedFile: null });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  async commit(title: string, description: string, amend: boolean) {
    set({ committing: true, error: null });
    try {
      const { status } = await api.commit(title, description, amend);
      set({ status, selectedFile: null });
      await Promise.all([get().loadCommits(true), get().loadBranches()]);
    } catch (e) {
      set({ error: errMsg(e) });
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
