import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { RepoInfo, StatusResult } from "../types";
import { useStore } from "./store";

vi.mock("../desktop", () => ({ openExternal: vi.fn() }));

const REPO_A: RepoInfo = { root: "C:/repos/a", branch: "main", head: "aaa" };
const REPO_B: RepoInfo = { root: "C:/repos/b", branch: "trunk", head: "bbb" };
const STATUS_A: StatusResult = { staged: [{ path: "a.txt", status: "M", staged: true }], unstaged: [] };
const STATUS_B: StatusResult = { staged: [], unstaged: [{ path: "b.txt", status: "M", staged: false }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForConfirm(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (useStore.getState().confirm) return;
    await Promise.resolve();
  }
  throw new Error("confirmation did not open");
}

function activate(repo: RepoInfo, status: StatusResult): void {
  useStore.setState({
    repo,
    tabs: [
      { id: "a", root: REPO_A.root, name: "a", branch: REPO_A.branch },
      { id: "b", root: REPO_B.root, name: "b", branch: REPO_B.branch },
    ],
    activeTabId: repo.root === REPO_A.root ? "a" : "b",
    status,
    remoteBusy: false,
    busyAction: null,
    committing: false,
    confirm: null,
    toasts: [],
  });
}

beforeEach(() => {
  useStore.getState().resolveConfirm(null);
  vi.restoreAllMocks();
  activate(REPO_A, STATUS_A);
});

describe("repo-bound core mutations", () => {
  it("does not refresh another repository after creating a pull request", async () => {
    const created = deferred<Awaited<ReturnType<typeof api.prCreate>>>();
    vi.spyOn(api, "prCreate").mockImplementation(() => created.promise);
    const remoteBranches = vi.spyOn(api, "remoteBranches");
    const operation = useStore.getState().createPullRequest({
      baseRepo: "owner/a", base: "main", headRepo: "owner/a", head: "feature",
      title: "Feature", body: "", draft: false, reviewers: [], assignees: [], labels: [],
    });
    activate(REPO_B, STATUS_B);
    created.resolve({ number: 1, htmlUrl: "https://github.com/owner/a/pull/1", warnings: [] });
    await operation;
    expect(remoteBranches).not.toHaveBeenCalled();
    expect(useStore.getState().repo).toEqual(REPO_B);
    expect(useStore.getState().toasts).toEqual([]);
  });

  it("does not create a pull request during another remote operation", async () => {
    useStore.setState({ remoteBusy: true, busyAction: "push" });
    const create = vi.spyOn(api, "prCreate");
    await expect(useStore.getState().createPullRequest({
      baseRepo: "owner/a", base: "main", headRepo: "owner/a", head: "feature",
      title: "Feature", body: "", draft: false, reviewers: [], assignees: [], labels: [],
    })).rejects.toThrow("Wait for the current remote operation");
    expect(create).not.toHaveBeenCalled();
    expect(useStore.getState().busyAction).toBe("push");
  });

  it.each(["pull", "force"] as const)(
    "does not run a rejected push's %s follow-up after switching repositories",
    async (choice) => {
      const pushed = deferred<Awaited<ReturnType<typeof api.push>>>();
      const pushSpy = vi.spyOn(api, "push").mockImplementation(() => pushed.promise);
      const pullSpy = vi.spyOn(api, "pull");

      const operation = useStore.getState().push();
      pushed.resolve({
        branch: "main",
        output: "rejected",
        rejected: true,
        upstream: "origin/main",
        branches: [],
      });
      await waitForConfirm();

      activate(REPO_B, STATUS_B);
      useStore.getState().resolveConfirm(choice);
      await operation;

      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pullSpy).not.toHaveBeenCalled();
      expect(useStore.getState().repo).toEqual(REPO_B);
    },
  );

  it("ignores a commit response that arrives after switching repositories", async () => {
    const committed = deferred<Awaited<ReturnType<typeof api.commit>>>();
    vi.spyOn(api, "commit").mockImplementation(() => committed.promise);
    const remoteBranches = vi.spyOn(api, "remoteBranches");

    const operation = useStore.getState().commit("title", "body", false);
    activate(REPO_B, STATUS_B);
    committed.resolve({ hash: "new-a", repo: { ...REPO_A, head: "new-a" }, status: { staged: [], unstaged: [] } });
    await operation;

    expect(remoteBranches).not.toHaveBeenCalled();
    expect(useStore.getState().repo).toEqual(REPO_B);
    expect(useStore.getState().status).toEqual(STATUS_B);
  });

  it("does not apply pull UI updates after switching during the post-pull refresh", async () => {
    vi.spyOn(api, "pull").mockResolvedValue({
      repo: { ...REPO_A, head: "pulled-a" },
      output: "updated",
      merge: {
        active: false,
        kind: null,
        intoBranch: "main",
        fromLabel: null,
        conflicted: [],
        message: "",
      },
      status: { staged: [], unstaged: [] },
    });
    const refreshed = deferred<Awaited<ReturnType<typeof api.remoteBranches>>>();
    const remoteBranches = vi.spyOn(api, "remoteBranches").mockImplementation(() => refreshed.promise);

    const operation = useStore.getState().pull();
    for (let i = 0; i < 20 && remoteBranches.mock.calls.length === 0; i += 1) await Promise.resolve();
    expect(remoteBranches).toHaveBeenCalledTimes(1);

    activate(REPO_B, STATUS_B);
    refreshed.resolve({ branches: [] });
    await operation;

    expect(useStore.getState().repo).toEqual(REPO_B);
    expect(useStore.getState().status).toEqual(STATUS_B);
    expect(useStore.getState().toasts).toEqual([]);
  });
});
