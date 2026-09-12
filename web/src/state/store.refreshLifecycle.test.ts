import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { StatusResult } from "../types";
import { useStore } from "./store";

vi.mock("../desktop", () => ({ openExternal: vi.fn() }));

beforeEach(() => {
  vi.restoreAllMocks();
  useStore.setState({
    repo: { root: "C:/repos/review", branch: "main", head: "aaa" },
    activeTabId: "review", tabs: [], status: { staged: [], unstaged: [] },
    opening: false, loadingStatus: false, toasts: [],
  });
});

it("settles status loading when opening another repository fails", async () => {
  let resolve!: (status: StatusResult) => void;
  const pending = new Promise<StatusResult>((done) => { resolve = done; });
  vi.spyOn(api, "status").mockReturnValue(pending);
  vi.spyOn(api, "openRepo").mockRejectedValue(new Error("Repository not found"));

  const refreshing = useStore.getState().refreshStatus();
  await useStore.getState().openRepo("C:/repos/missing");
  resolve({ staged: [], unstaged: [{ path: "changed.txt", status: "M", staged: false }] });
  await refreshing;

  expect(useStore.getState().loadingStatus).toBe(false);
});

it("keeps a replacement scan loading after a failed repository open", async () => {
  let resolveFirst!: (status: StatusResult) => void;
  let resolveSecond!: (status: StatusResult) => void;
  const first = new Promise<StatusResult>((done) => { resolveFirst = done; });
  const second = new Promise<StatusResult>((done) => { resolveSecond = done; });
  vi.spyOn(api, "status").mockReturnValueOnce(first).mockReturnValueOnce(second);
  vi.spyOn(api, "openRepo").mockRejectedValue(new Error("Repository not found"));

  const oldRefresh = useStore.getState().refreshStatus();
  await useStore.getState().openRepo("C:/repos/missing");
  const newRefresh = useStore.getState().refreshStatus();
  resolveFirst({ staged: [], unstaged: [] });
  await oldRefresh;
  expect(useStore.getState().loadingStatus).toBe(true);

  resolveSecond({ staged: [], unstaged: [] });
  await newRefresh;
  expect(useStore.getState().loadingStatus).toBe(false);
});

it("does not let an old hydration clear saved visible refs after returning to the same repository", async () => {
  const root = "C:/repos/review";
  const ref = "refs/remotes/origin/main";
  const refs = { branches: [{ name: "origin/main", remote: "origin", shortName: "main", ref, shortHash: "aaa" }] };
  const values = new Map([["gwui.visibleRefs", JSON.stringify({ [root]: [ref] })]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  let resolveOld!: (value: Awaited<ReturnType<typeof api.remoteBranches>>) => void;
  let resolveNew!: (value: Awaited<ReturnType<typeof api.remoteBranches>>) => void;
  const oldRefs = new Promise<Awaited<ReturnType<typeof api.remoteBranches>>>((done) => { resolveOld = done; });
  const newRefs = new Promise<Awaited<ReturnType<typeof api.remoteBranches>>>((done) => { resolveNew = done; });
  vi.spyOn(api, "openRepo").mockResolvedValue({ repo: { root, branch: "main", head: "aaa" } });
  vi.spyOn(api, "status").mockResolvedValue({ staged: [], unstaged: [] });
  vi.spyOn(api, "remoteBranches").mockReturnValueOnce(oldRefs).mockReturnValueOnce(newRefs);
  vi.spyOn(api, "branches").mockResolvedValue({ branches: [] });
  vi.spyOn(api, "commits").mockResolvedValue({ commits: [], hasMore: false });
  vi.spyOn(api, "remotes").mockResolvedValue({ remotes: [] });
  vi.spyOn(api, "stashes").mockResolvedValue({ stashes: [] });
  vi.spyOn(api, "worktrees").mockResolvedValue({ worktrees: [] });
  vi.spyOn(useStore.getState(), "loadMergeState").mockResolvedValue();
  useStore.setState({ tabs: [{ id: "review", root, name: "review", branch: "main" }] });

  const first = useStore.getState().selectTab("review");
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  useStore.getState().newTab();
  const second = useStore.getState().selectTab("review");
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  resolveOld(refs);
  await first;
  const savedBeforeNewResponse = JSON.parse(values.get("gwui.visibleRefs") ?? "{}");
  resolveNew(refs);
  await second;
  vi.unstubAllGlobals();

  expect(savedBeforeNewResponse[root]).toEqual([ref]);
  expect(useStore.getState().visibleRefs).toEqual([ref]);
});
