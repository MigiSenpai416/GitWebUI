import { create } from "zustand";
import { api } from "../api/client";
import type { Commit, SelectedFile } from "../types";
import { useStore } from "./store";

interface CommitSearchState {
  open: boolean;
  query: string;
  rows: Pick<Commit, "hash" | "parents">[];
  matches: number[];
  current: number;
  navigation: number;
  cache: Record<string, Commit>;
  loading: boolean;
  error: string | null;
  reset: () => void;
  toggle: () => void;
  search: (query: string, refresh?: boolean) => void;
  navigate: (direction: number) => void;
  choose: (hash: string) => void;
  hydrate: (hashes: string[]) => void;
}

let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let controller = new AbortController();
let pending = new Set<string>();
let loaded = new Set<string>();
let viewport: string[] = [];
let activeRequests = 0;
let hydrationTimer: ReturnType<typeof setTimeout> | undefined;
let selectionTimer: ReturnType<typeof setTimeout> | undefined;
let selection: {
  hash: string;
  version: number;
  root: string;
  file: SelectedFile | null;
  commitHash: string | null;
  stashHash: string | null;
  ready: boolean;
} | null = null;
let searchRoot: string | undefined;
const CACHE_LIMIT = 600;

function cancelSearch() {
  ++generation;
  clearTimeout(timer);
  clearTimeout(hydrationTimer);
  clearTimeout(selectionTimer);
  hydrationTimer = undefined;
  selection = null;
  controller.abort();
  controller = new AbortController();
  pending = new Set();
  viewport = [];
  activeRequests = 0;
}

export const useCommitSearch = create<CommitSearchState>((set, get) => ({
  open: false,
  query: "",
  rows: [],
  matches: [],
  current: -1,
  navigation: 0,
  cache: {},
  loading: false,
  error: null,

  reset() {
    cancelSearch();
    searchRoot = undefined;
    loaded = new Set();
    set({ open: false, query: "", rows: [], matches: [], current: -1, cache: {}, loading: false, error: null });
  },

  toggle() {
    if (get().open) {
      get().search("");
      set({ open: false });
    } else {
      set({ open: true });
    }
  },

  search(query, refresh = false) {
    const previous = get();
    const app = useStore.getState();
    const previousHash = previous.query === query ? previous.rows[previous.matches[previous.current]]?.hash : undefined;
    const resumeSelection = previousHash && selection?.hash === previousHash &&
      selection.version === app.selectionVersion && selection.file === app.selectedFile &&
      selection.root === app.repo?.root && selection.commitHash === app.selectedCommitHash &&
      selection.stashHash === app.selectedStashHash && !app.worktreeCreateOpen;
    cancelSearch();
    if (refresh) loaded.clear();
    const request = generation;
    const root = useStore.getState().repo?.root;
    searchRoot = root;
    const signal = controller.signal;
    const selectionVersion = useStore.getState().selectionVersion;
    const selectedFile = useStore.getState().selectedFile;
    const selectedCommitHash = useStore.getState().selectedCommitHash;
    const selectedStashHash = useStore.getState().selectedStashHash;
    set({ query, rows: [], matches: [], current: -1, loading: !!query.trim() && !!root, error: null });
    if (!query.trim() || !root) return;
    timer = setTimeout(async () => {
      if (request !== generation || useStore.getState().repo?.root !== root) return;
      try {
        const result = await api.searchCommits(query, signal);
        if (request !== generation || useStore.getState().repo?.root !== root) return;
        set({ ...result, loading: false });
        if (result.matches.length) {
          const app = useStore.getState();
          const canSelect = app.selectionVersion === selectionVersion && app.selectedFile === selectedFile &&
            app.selectedCommitHash === selectedCommitHash && app.selectedStashHash === selectedStashHash && !app.worktreeCreateOpen;
          const current = previousHash ? result.matches.findIndex((index) => result.rows[index].hash === previousHash) : -1;
          set({ current: current < 0 ? 0 : current });
          if (previousHash && current >= 0) {
            if (resumeSelection && canSelect) get().navigate(0);
            else set((s) => ({ navigation: s.navigation + 1 }));
          } else {
            if (canSelect) get().navigate(0);
          }
        }
      } catch (e) {
        if (request === generation && useStore.getState().repo?.root === root) {
          set({ loading: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }, 200);
  },

  navigate(direction) {
    const { matches, current, rows } = get();
    if (!matches.length) return;
    const next = current < 0 ? direction < 0 ? matches.length - 1 : 0 :
      (current + direction + matches.length) % matches.length;
    const hash = rows[matches[next]].hash;
    set((s) => ({ current: next, navigation: s.navigation + 1 }));
    clearTimeout(selectionTimer);
    const state = useStore.getState();
    selection = {
      hash, version: state.selectionVersion, root: state.repo?.root ?? "", file: state.selectedFile,
      commitHash: state.selectedCommitHash, stashHash: state.selectedStashHash, ready: false,
    };
    selectionTimer = setTimeout(() => {
      if (selection) selection.ready = true;
      finishSelection();
    }, 75);
    scheduleHydration();
  },

  choose(hash) {
    clearTimeout(selectionTimer);
    selection = null;
    const { rows, matches } = get();
    set((s) => ({ current: matches.findIndex((index) => rows[index].hash === hash), navigation: s.navigation + 1 }));
    void useStore.getState().selectCommit(hash);
  },

  hydrate(hashes) {
    viewport = hashes;
    scheduleHydration();
  },
}));

function finishSelection() {
  if (!selection?.ready) return;
  const state = useStore.getState();
  if (state.repo?.root !== selection.root || state.selectionVersion !== selection.version ||
    state.selectedFile !== selection.file || state.selectedCommitHash !== selection.commitHash ||
    state.selectedStashHash !== selection.stashHash || state.worktreeCreateOpen) {
    selection = null;
    return;
  }
  if (!useCommitSearch.getState().cache[selection.hash]) return;
  const hash = selection.hash;
  selection = null;
  if (state.selectedCommitHash !== hash) void state.selectCommit(hash);
}

function wantedHashes() {
  return [...new Set([...(selection ? [selection.hash] : []), ...viewport])];
}

function scheduleHydration() {
  if (hydrationTimer !== undefined) return;
  hydrationTimer = setTimeout(() => {
    hydrationTimer = undefined;
    pumpHydration();
  }, 20);
}

function pumpHydration() {
  const state = useCommitSearch.getState();
  if (!state.open || state.error || !searchRoot || useStore.getState().repo?.root !== searchRoot) return;
  const missing = wantedHashes().filter((hash) => !loaded.has(hash) && !pending.has(hash));
  while (activeRequests < 2 && missing.length) {
    const hashes = missing.splice(0, 80);
    const request = generation;
    const root = useStore.getState().repo?.root;
    const signal = controller.signal;
    hashes.forEach((hash) => pending.add(hash));
    activeRequests += 1;
    void api.commitsByHash(hashes, signal).then(({ commits }) => {
      if (request !== generation || useStore.getState().repo?.root !== root) return;
      if (hashes.some((hash) => !commits.some((commit) => commit.hash === hash))) {
        throw new Error("Some commits are no longer available. Retry to refresh the search.");
      }
      const cache = { ...useCommitSearch.getState().cache };
      for (const commit of commits) {
        delete cache[commit.hash];
        cache[commit.hash] = commit;
        loaded.add(commit.hash);
      }
      const app = useStore.getState();
      const keep = new Set([...wantedHashes(), app.selectedCommitHash, app.commitMenu?.hash, app.branchDialogHash]);
      let excess = Object.keys(cache).length - CACHE_LIMIT;
      for (const hash of Object.keys(cache)) {
        if (excess <= 0) break;
        if (keep.has(hash)) continue;
        delete cache[hash];
        loaded.delete(hash);
        excess -= 1;
      }
      useCommitSearch.setState({ cache });
      finishSelection();
    }).catch((e) => {
      if (request === generation && useStore.getState().repo?.root === root) {
        useCommitSearch.setState({ error: e instanceof Error ? e.message : String(e) });
      }
    }).finally(() => {
      if (request !== generation) return;
      hashes.forEach((hash) => pending.delete(hash));
      activeRequests -= 1;
      pumpHydration();
    });
  }
}
