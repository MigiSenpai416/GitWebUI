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

  init: () => Promise<void>;
  loadRecent: () => Promise<void>;
  openRepo: (path: string) => Promise<void>;
  closeRepo: () => void;

  loadCommits: (reset: boolean) => Promise<void>;
  selectCommit: (hash: string | null) => Promise<void>;

  loadBranches: () => Promise<void>;
  checkout: (branch: string) => Promise<void>;

  refreshStatus: () => Promise<void>;
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
