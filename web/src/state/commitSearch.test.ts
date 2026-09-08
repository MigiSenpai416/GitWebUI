import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { useStore } from "./store";
import { useCommitSearch } from "./commitSearch";
import type { Commit } from "../types";

const commit = (hash: string): Commit => ({
  hash, shortHash: hash, parents: [], subject: hash, body: "", author: "A", email: "a@b.c", dateISO: "", refs: [],
});
const rows = [{ hash: "new", parents: ["old"] }, { hash: "old", parents: [] }];

beforeEach(() => {
  vi.useFakeTimers();
  useCommitSearch.getState().reset();
  useCommitSearch.setState({ open: true });
  useStore.setState({ repo: { root: "C:/repo", branch: "main", head: "new" }, selectionVersion: 0, selectedCommitHash: null, selectedFile: null, worktreeCreateOpen: false });
  vi.spyOn(useStore.getState(), "selectCommit").mockImplementation(async (hash) => {
    useStore.setState((s) => ({ selectedCommitHash: hash, selectionVersion: s.selectionVersion + 1 }));
  });
  vi.spyOn(api, "commitsByHash").mockImplementation(async (hashes) => ({ commits: hashes.map(commit) }));
});

afterEach(() => {
  useCommitSearch.getState().reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("commit search state", () => {
  it("debounces typing and wraps navigation in both directions", async () => {
    const request = vi.spyOn(api, "searchCommits").mockResolvedValue({ rows, matches: [0, 1] });
    useCommitSearch.getState().search("n");
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(300);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("needle");
    expect(useStore.getState().selectCommit).toHaveBeenLastCalledWith("new");
    useCommitSearch.getState().navigate(-1);
    await vi.advanceTimersByTimeAsync(100);
    expect(useCommitSearch.getState().current).toBe(1);
    expect(useStore.getState().selectCommit).toHaveBeenLastCalledWith("old");
    useCommitSearch.getState().navigate(1);
    expect(useCommitSearch.getState().current).toBe(0);
  });

  it("ignores responses after clearing, closing, or changing repositories", async () => {
    let resolve!: (value: { rows: typeof rows; matches: number[] }) => void;
    vi.spyOn(api, "searchCommits").mockImplementation(() => new Promise((done) => { resolve = done; }));
    useCommitSearch.getState().search("old query");
    await vi.advanceTimersByTimeAsync(300);
    useCommitSearch.getState().search("");
    resolve({ rows, matches: [0] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useCommitSearch.getState().rows).toEqual([]);
    useCommitSearch.getState().search("other query");
    await vi.advanceTimersByTimeAsync(300);
    useStore.setState({ repo: { root: "C:/other", branch: "main", head: "other" } });
    resolve({ rows, matches: [0] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useCommitSearch.getState().rows).toEqual([]);
    expect(useStore.getState().selectCommit).not.toHaveBeenCalled();
  });

  it("selects only the latest target when detail requests finish out of order", async () => {
    const pending = new Map<string, (value: { commits: Commit[] }) => void>();
    vi.mocked(api.commitsByHash).mockImplementation((hashes) => new Promise((resolve) => { pending.set(hashes[0], resolve); }));
    vi.spyOn(api, "searchCommits").mockResolvedValue({ rows, matches: [0, 1] });
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(300);
    useCommitSearch.getState().navigate(1);
    await vi.advanceTimersByTimeAsync(25);
    useCommitSearch.getState().navigate(1);
    pending.get("old")!({ commits: [commit("old")] });
    await vi.advanceTimersByTimeAsync(100);
    expect(useStore.getState().selectCommit).not.toHaveBeenCalled();
    pending.get("new")!({ commits: [commit("new")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useStore.getState().selectCommit).toHaveBeenLastCalledWith("new");
  });

  it("does not steal selection after the user returns to working changes", async () => {
    let resolve!: (value: { commits: Commit[] }) => void;
    vi.mocked(api.commitsByHash).mockImplementation(() => new Promise((done) => { resolve = done; }));
    vi.spyOn(api, "searchCommits").mockResolvedValue({ rows, matches: [0] });
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(300);
    await useStore.getState().selectCommit(null);
    resolve({ commits: [commit("new")] });
    await vi.advanceTimersByTimeAsync(100);
    expect(useStore.getState().selectedCommitHash).toBeNull();
    expect(useStore.getState().selectCommit).toHaveBeenCalledTimes(1);
  });

  it("bounds cold scrolling to two requests and drops superseded queued viewports", async () => {
    const responses: Array<() => void> = [];
    vi.mocked(api.commitsByHash).mockImplementation((hashes) => new Promise((resolve) => {
      responses.push(() => resolve({ commits: hashes.map(commit) }));
    }));
    vi.spyOn(api, "searchCommits").mockResolvedValue({ rows, matches: [] });
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(200);
    for (let index = 0; index < 100; index += 1) {
      useCommitSearch.getState().hydrate([`viewport-${index}`]);
      await vi.advanceTimersByTimeAsync(25);
    }
    expect(api.commitsByHash).toHaveBeenCalledTimes(2);
    responses[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.commitsByHash).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.commitsByHash).mock.calls[2][0]).toEqual(["viewport-99"]);
    responses[1]();
    responses[2]();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.commitsByHash).toHaveBeenCalledTimes(3);
  });

  it("reuses cached metadata across queries and bounds retained commit bodies", async () => {
    vi.spyOn(api, "searchCommits").mockResolvedValue({ rows, matches: [] });
    useCommitSearch.getState().search("first");
    await vi.advanceTimersByTimeAsync(200);
    for (let page = 0; page < 20; page += 1) {
      useCommitSearch.getState().hydrate(Array.from({ length: 80 }, (_, index) => `commit-${page * 80 + index}`));
      await vi.advanceTimersByTimeAsync(25);
    }
    expect(Object.keys(useCommitSearch.getState().cache).length).toBeLessThanOrEqual(600);
    const calls = vi.mocked(api.commitsByHash).mock.calls.length;
    useCommitSearch.getState().search("second");
    await vi.advanceTimersByTimeAsync(200);
    useCommitSearch.getState().hydrate(["commit-1599"]);
    await vi.advanceTimersByTimeAsync(25);
    expect(api.commitsByHash).toHaveBeenCalledTimes(calls);
    useCommitSearch.getState().search("second", true);
    await vi.advanceTimersByTimeAsync(200);
    useCommitSearch.getState().hydrate(["commit-1599"]);
    await vi.advanceTimersByTimeAsync(25);
    expect(api.commitsByHash).toHaveBeenCalledTimes(calls + 1);
  });

  it("coalesces cached-hit key repeats and does not reload the selected commit", async () => {
    vi.spyOn(api, "searchCommits").mockResolvedValue({ rows, matches: [0, 1] });
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(300);
    useCommitSearch.getState().hydrate(["old"]);
    await vi.advanceTimersByTimeAsync(25);
    vi.mocked(useStore.getState().selectCommit).mockClear();
    for (let index = 0; index < 21; index += 1) {
      useCommitSearch.getState().navigate(1);
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(useStore.getState().selectCommit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(useStore.getState().selectCommit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().selectedCommitHash).toBe("old");
    useCommitSearch.getState().navigate(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(useStore.getState().selectCommit).toHaveBeenCalledTimes(1);
  });

  it("resumes an outstanding navigation after refreshing the same query", async () => {
    vi.spyOn(api, "searchCommits").mockResolvedValue({ rows, matches: [0, 1] });
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(300);
    expect(useStore.getState().selectedCommitHash).toBe("new");
    vi.mocked(api.commitsByHash).mockImplementationOnce(() => new Promise(() => {}));
    useCommitSearch.getState().navigate(1);
    await vi.advanceTimersByTimeAsync(100);
    useCommitSearch.getState().search("needle", true);
    await vi.advanceTimersByTimeAsync(300);
    expect(useStore.getState().selectedCommitHash).toBe("old");
    expect(useCommitSearch.getState().current).toBe(1);
  });

  it("invalidates metadata when a repository refresh happens with search closed", async () => {
    vi.spyOn(api, "searchCommits").mockResolvedValue({ rows, matches: [0] });
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(300);
    useCommitSearch.getState().toggle();
    useCommitSearch.getState().search("", true);
    useCommitSearch.getState().toggle();
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(300);
    expect(api.commitsByHash).toHaveBeenCalledTimes(2);
  });

  it("does not revive navigation when checkout directly clears the selection before refresh", async () => {
    vi.spyOn(api, "searchCommits").mockResolvedValue({ rows, matches: [0, 1] });
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(300);
    vi.mocked(api.commitsByHash).mockImplementationOnce(() => new Promise(() => {}));
    useCommitSearch.getState().navigate(1);
    await vi.advanceTimersByTimeAsync(100);
    useStore.setState({ selectedCommitHash: null });
    useCommitSearch.getState().search("needle", true);
    await vi.advanceTimersByTimeAsync(300);
    expect(useStore.getState().selectedCommitHash).toBeNull();
  });

  it("does not close a file opened while the search request is pending", async () => {
    let resolve!: (value: { rows: typeof rows; matches: number[] }) => void;
    vi.spyOn(api, "searchCommits").mockImplementation(() => new Promise((done) => { resolve = done; }));
    useCommitSearch.getState().search("needle");
    await vi.advanceTimersByTimeAsync(200);
    useStore.setState({ selectedFile: { source: "commit", hash: "old", path: "file.txt", status: "M" } });
    resolve({ rows, matches: [0] });
    await vi.advanceTimersByTimeAsync(300);
    expect(useStore.getState().selectCommit).not.toHaveBeenCalled();
    expect(useStore.getState().selectedFile?.path).toBe("file.txt");
  });
});
