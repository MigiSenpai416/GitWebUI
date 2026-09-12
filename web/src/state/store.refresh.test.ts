import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { RepoInfo, StatusResult } from "../types";
import { useStore } from "./store";

vi.mock("../desktop", () => ({ openExternal: vi.fn() }));

const REPO: RepoInfo = { root: "C:/repos/refresh", branch: "main", head: "aaa" };
const EMPTY: StatusResult = { staged: [], unstaged: [] };
const CHANGED: StatusResult = {
  staged: [], unstaged: [{ path: "file.txt", status: "M", staged: false }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.restoreAllMocks();
  useStore.setState({
    repo: REPO, activeTabId: "refresh", tabs: [], status: EMPTY, commits: [],
    opening: false, committing: false, loadingStatus: false, refreshTick: 0,
    visibleRefs: [], toasts: [],
  });
  vi.spyOn(api, "currentRepo").mockResolvedValue({ repo: REPO });
  vi.spyOn(api, "status").mockResolvedValue(EMPTY);
  vi.spyOn(api, "commits").mockResolvedValue({ commits: [], hasMore: false });
  vi.spyOn(api, "remoteBranches").mockResolvedValue({ branches: [] });
  vi.spyOn(api, "branches").mockResolvedValue({ branches: [] });
  vi.spyOn(api, "remotes").mockResolvedValue({ remotes: [] });
  vi.spyOn(api, "stashes").mockResolvedValue({ stashes: [] });
  vi.spyOn(api, "worktrees").mockResolvedValue({ worktrees: [] });
  vi.spyOn(useStore.getState(), "loadMergeState").mockResolvedValue();
});

describe("status refresh", () => {
  it("publishes status while repository metadata and remote refs are still pending", async () => {
    const metadata = deferred<Awaited<ReturnType<typeof api.currentRepo>>>();
    const refs = deferred<Awaited<ReturnType<typeof api.remoteBranches>>>();
    vi.mocked(api.currentRepo).mockReturnValue(metadata.promise);
    vi.mocked(api.remoteBranches).mockReturnValue(refs.promise);
    vi.mocked(api.status).mockResolvedValue(CHANGED);

    const refresh = useStore.getState().refreshAll();
    await flush();
    expect(useStore.getState().status).toEqual(CHANGED);
    expect(api.remoteBranches).not.toHaveBeenCalled();
    metadata.resolve({ repo: REPO });
    await flush();
    expect(api.commits).not.toHaveBeenCalled();
    refs.resolve({ branches: [] });
    await refresh;
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(api.commits).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping status requests into one scan and one trailing scan", async () => {
    const first = deferred<StatusResult>();
    const last = deferred<StatusResult>();
    vi.mocked(api.status).mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const requests = Array.from({ length: 10 }, () => useStore.getState().refreshStatus());
    expect(api.status).toHaveBeenCalledTimes(1);
    first.resolve(EMPTY);
    await flush();
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(useStore.getState().loadingStatus).toBe(true);
    last.resolve(CHANGED);
    await Promise.all(requests);
    expect(useStore.getState().status).toEqual(CHANGED);
    expect(useStore.getState().loadingStatus).toBe(false);
  });

  it("does not replace the result of staging with an older status response", async () => {
    const old = deferred<StatusResult>();
    vi.mocked(api.status).mockReturnValue(old.promise);
    const staged: StatusResult = { staged: [{ path: "file.txt", status: "M", staged: true }], unstaged: [] };
    vi.spyOn(api, "stage").mockResolvedValue(staged);
    const refresh = useStore.getState().refreshStatus();
    await useStore.getState().stage(["file.txt"]);
    old.resolve(CHANGED);
    await refresh;
    expect(useStore.getState().status).toBe(staged);
  });

  it("keeps unchanged arrays and replaces entries whose rename source changes", async () => {
    const previous: StatusResult = {
      staged: [{ path: "new.txt", oldPath: "old.txt", status: "R", staged: true }],
      unstaged: CHANGED.unstaged,
    };
    useStore.setState({ status: previous });
    vi.mocked(api.status).mockResolvedValue(structuredClone(previous));
    await useStore.getState().refreshStatus();
    expect(useStore.getState().status).toBe(previous);
    vi.mocked(api.status).mockResolvedValue({
      staged: [{ ...previous.staged[0], oldPath: "another.txt" }],
      unstaged: structuredClone(previous.unstaged),
    });
    await useStore.getState().refreshStatus();
    expect(useStore.getState().status.staged[0].oldPath).toBe("another.txt");
    expect(useStore.getState().status.unstaged).toBe(previous.unstaged);
  });

  it("does not apply an old repository response or clear the new repository's loading state", async () => {
    const old = deferred<StatusResult>();
    const next = deferred<StatusResult>();
    vi.mocked(api.status).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = useStore.getState().refreshStatus();
    useStore.setState({ repo: { ...REPO, root: "C:/repos/next" }, activeTabId: "next", status: EMPTY });
    const second = useStore.getState().refreshStatus();
    old.resolve(CHANGED);
    await first;
    expect(useStore.getState().status).toBe(EMPTY);
    expect(useStore.getState().loadingStatus).toBe(true);
    next.resolve(EMPTY);
    await second;
    expect(useStore.getState().loadingStatus).toBe(false);
  });

  it("recovers after a failed scan", async () => {
    vi.mocked(api.status).mockRejectedValueOnce(new Error("scan failed")).mockResolvedValueOnce(CHANGED);
    await useStore.getState().refreshStatus();
    expect(useStore.getState().loadingStatus).toBe(false);
    await useStore.getState().refreshStatus();
    expect(useStore.getState().status).toEqual(CHANGED);
  });
});

describe("commit completion", () => {
  it("loads another repository's status while a commit is still running", async () => {
    const committed = deferred<Awaited<ReturnType<typeof api.commit>>>();
    vi.spyOn(api, "commit").mockReturnValue(committed.promise);
    const next = { ...REPO, root: "C:/repos/next" };
    useStore.setState({ tabs: [{ id: "next", root: next.root, name: "next", branch: "main" }] });
    vi.spyOn(api, "openRepo").mockResolvedValue({ repo: next });
    vi.mocked(api.status).mockResolvedValue(CHANGED);
    const committing = useStore.getState().commit("summary", "", false);
    await useStore.getState().selectTab("next");
    expect(useStore.getState().committing).toBe(true);
    expect(useStore.getState().status).toEqual(CHANGED);
    committed.resolve({ hash: "bbb", repo: { ...REPO, head: "bbb" }, status: EMPTY });
    await committing;
    expect(useStore.getState().repo).toBe(next);
    expect(useStore.getState().status).toEqual(CHANGED);
  });

  it("reloads hook changes after returning to a repository whose commit fails", async () => {
    const committed = deferred<Awaited<ReturnType<typeof api.commit>>>();
    vi.spyOn(api, "commit").mockReturnValue(committed.promise);
    useStore.setState({ tabs: [{ id: "refresh", root: REPO.root, name: "refresh", branch: "main" }] });
    vi.spyOn(api, "openRepo").mockResolvedValue({ repo: REPO });
    const committing = useStore.getState().commit("summary", "", false);
    useStore.getState().newTab();
    await useStore.getState().selectTab("refresh");
    vi.mocked(api.status).mockResolvedValue(CHANGED);
    const failure = expect(committing).rejects.toThrow("hook rejected");
    committed.reject(new Error("hook rejected"));
    await failure;
    await flush();
    expect(useStore.getState().status).toEqual(CHANGED);
    expect(useStore.getState().committing).toBe(false);
  });

  it("finishes with the returned status without waiting for sidebar data or scanning again", async () => {
    const refs = deferred<Awaited<ReturnType<typeof api.remoteBranches>>>();
    vi.mocked(api.remoteBranches).mockReturnValue(refs.promise);
    const repo = { ...REPO, head: "bbb" };
    vi.spyOn(api, "commit").mockResolvedValue({ hash: "bbb", repo, status: CHANGED });
    await useStore.getState().commit("summary", "", false);
    expect(useStore.getState().committing).toBe(false);
    expect(useStore.getState().status).toBe(CHANGED);
    expect(useStore.getState().repo).toBe(repo);
    expect(api.status).not.toHaveBeenCalled();
    expect(api.commits).not.toHaveBeenCalled();
    refs.resolve({ branches: [] });
    await flush();
    expect(api.commits).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate submissions and retains errors from Git", async () => {
    const committed = deferred<Awaited<ReturnType<typeof api.commit>>>();
    vi.spyOn(api, "commit").mockReturnValue(committed.promise);
    const first = useStore.getState().commit("summary", "", false);
    await expect(useStore.getState().commit("summary", "", false)).rejects.toThrow("already running");
    const failure = expect(first).rejects.toThrow("hook rejected");
    committed.reject(new Error("hook rejected"));
    await failure;
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().committing).toBe(false);
    expect(useStore.getState().status).toBe(EMPTY);
  });

  it("rejects stale focus metadata and status after committing", async () => {
    const metadata = deferred<Awaited<ReturnType<typeof api.currentRepo>>>();
    const status = deferred<StatusResult>();
    vi.mocked(api.currentRepo).mockReturnValue(metadata.promise);
    vi.mocked(api.status).mockReturnValue(status.promise);
    const refresh = useStore.getState().refreshAll();
    const repo = { ...REPO, head: "bbb" };
    vi.spyOn(api, "commit").mockResolvedValue({ hash: "bbb", repo, status: CHANGED });
    await useStore.getState().commit("summary", "", false);
    metadata.resolve({ repo: REPO });
    status.resolve(EMPTY);
    await refresh;
    await flush();
    expect(useStore.getState().repo).toBe(repo);
    expect(useStore.getState().status).toBe(CHANGED);
  });
});
