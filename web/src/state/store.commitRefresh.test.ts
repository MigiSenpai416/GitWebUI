import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Branch, MergeState, RepoInfo } from "../types";
import { useStore } from "./store";

vi.mock("../desktop", () => ({ openExternal: vi.fn() }));

const REPO: RepoInfo = { root: "C:/repos/commit-review", branch: "main", head: "aaa" };
const EMPTY = { staged: [], unstaged: [] };
const NO_MERGE: MergeState = { active: false, kind: null, intoBranch: "main", fromLabel: null, conflicted: [], message: "" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useStore.setState({
    repo: REPO, activeTabId: "commit-review", tabs: [], status: EMPTY, commits: [],
    opening: false, committing: false, loadingStatus: false, refreshTick: 0,
    visibleRefs: [], toasts: [], mergeState: null, mergeSeen: [], conflictPath: null, conflictData: null,
  });
  vi.spyOn(api, "status").mockResolvedValue(EMPTY);
  vi.spyOn(api, "commits").mockResolvedValue({ commits: [], hasMore: false });
  vi.spyOn(api, "remoteBranches").mockResolvedValue({ branches: [] });
  vi.spyOn(api, "branches").mockResolvedValue({ branches: [] });
  vi.spyOn(api, "remotes").mockResolvedValue({ remotes: [] });
  vi.spyOn(api, "stashes").mockResolvedValue({ stashes: [] });
  vi.spyOn(api, "worktrees").mockResolvedValue({ worktrees: [] });
  vi.spyOn(api, "mergeState").mockResolvedValue({ merge: NO_MERGE });
});

it("retains saved visible refs when a commit finishes while the repository is hydrating", async () => {
  const ref = "refs/heads/main";
  const values = new Map([["gwui.visibleRefs", JSON.stringify({ [REPO.root]: [ref] })]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const initialBranches = deferred<Awaited<ReturnType<typeof api.branches>>>();
  const initialRemoteBranches = deferred<Awaited<ReturnType<typeof api.remoteBranches>>>();
  const nextRemoteBranches = deferred<Awaited<ReturnType<typeof api.remoteBranches>>>();
  const branch: Branch = { name: "main", current: true, shortHash: "bbb", upstream: "origin/main", ahead: 1, behind: 0, upstreamGone: false };
  vi.mocked(api.branches).mockReturnValueOnce(initialBranches.promise).mockResolvedValue({ branches: [branch] });
  vi.mocked(api.remoteBranches).mockReturnValueOnce(initialRemoteBranches.promise).mockReturnValueOnce(nextRemoteBranches.promise);
  vi.mocked(api.status).mockResolvedValue({ staged: [{ path: "file.txt", status: "A", staged: true }], unstaged: [] });
  vi.spyOn(api, "openRepo").mockResolvedValue({ repo: REPO });
  vi.spyOn(api, "commit").mockResolvedValue({ hash: "bbb", repo: { ...REPO, head: "bbb" }, status: EMPTY });
  useStore.setState({ tabs: [{ id: "commit-review", root: REPO.root, name: "review", branch: "main" }] });
  const opening = useStore.getState().selectTab("commit-review");
  await flush();
  expect(useStore.getState().status.staged).toHaveLength(1);
  await useStore.getState().commit("first", "", false);
  initialBranches.resolve({ branches: [{ ...branch, shortHash: "aaa", ahead: 0 }] });
  initialRemoteBranches.resolve({ branches: [] });
  await flush();
  nextRemoteBranches.resolve({ branches: [] });
  await opening;
  await flush();
  expect(useStore.getState().branches).toEqual([branch]);
  expect(useStore.getState().visibleRefs).toEqual([ref]);
  expect(JSON.parse(values.get("gwui.visibleRefs") ?? "{}")[REPO.root]).toEqual([ref]);
});

it("does not close a newer merge conflict resolver when an old commit refresh completes", async () => {
  const oldMerge = deferred<{ merge: MergeState }>();
  const merge: MergeState = { active: true, kind: "merge", intoBranch: "main", fromLabel: "feature", conflicted: ["file.txt"], message: "Merge feature" };
  vi.mocked(api.mergeState).mockReturnValueOnce(oldMerge.promise).mockResolvedValueOnce({ merge });
  vi.spyOn(api, "commit").mockResolvedValue({ hash: "bbb", repo: { ...REPO, head: "bbb" }, status: EMPTY });
  await useStore.getState().commit("first", "", false);
  await flush();
  expect(api.mergeState).toHaveBeenCalledTimes(1);
  vi.spyOn(api, "merge").mockResolvedValue({ repo: { ...REPO, head: "bbb" }, merge, status: EMPTY });
  await useStore.getState().mergeBranch("feature");
  const conflictData = { path: "file.txt", merged: "conflict", oursLabel: "main", theirsLabel: "feature" };
  useStore.setState({ conflictPath: "file.txt", conflictData });
  oldMerge.resolve({ merge: NO_MERGE });
  await flush();
  expect(useStore.getState().mergeState).toEqual(merge);
  expect(useStore.getState().mergeSeen).toEqual(["file.txt"]);
  expect(useStore.getState().conflictPath).toBe("file.txt");
  expect(useStore.getState().conflictData).toBe(conflictData);
});

it("does not overwrite newer branch data when successive commits finish their refreshes out of order", async () => {
  const firstBranches = deferred<{ branches: Branch[] }>();
  const branch: Branch = { name: "main", current: true, shortHash: "bbb", upstream: "origin/main", ahead: 1, behind: 0, upstreamGone: false };
  const latestBranch = { ...branch, shortHash: "ccc", ahead: 2 };
  vi.mocked(api.branches).mockReturnValueOnce(firstBranches.promise).mockResolvedValueOnce({ branches: [latestBranch] });
  vi.spyOn(api, "commit")
    .mockResolvedValueOnce({ hash: "bbb", repo: { ...REPO, head: "bbb" }, status: EMPTY })
    .mockResolvedValueOnce({ hash: "ccc", repo: { ...REPO, head: "ccc" }, status: EMPTY });
  await useStore.getState().commit("first", "", false);
  await flush();
  expect(api.branches).toHaveBeenCalledTimes(1);
  useStore.setState({ status: { staged: [{ path: "next.txt", status: "A", staged: true }], unstaged: [] } });
  await useStore.getState().commit("second", "", false);
  await flush();
  expect(useStore.getState().branches).toEqual([latestBranch]);
  firstBranches.resolve({ branches: [branch] });
  await flush();
  expect(useStore.getState().branches).toEqual([latestBranch]);
});
