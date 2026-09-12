import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Branch, RepoInfo } from "../types";
import { useStore } from "./store";

vi.mock("../desktop", () => ({ openExternal: vi.fn() }));

const REPO: RepoInfo = { root: "C:/repos/mutation-refresh", branch: "feature", head: "aaa" };
const BRANCH: Branch = { name: "feature", current: true, shortHash: "aaa", upstream: "origin/feature", ahead: 0, behind: 0, upstreamGone: false };

beforeEach(() => {
  vi.restoreAllMocks();
  useStore.setState({
    repo: REPO, activeTabId: "mutation-refresh", tabs: [], branches: [BRANCH],
    status: { staged: [], unstaged: [] }, commits: [], visibleRefs: [],
    opening: false, committing: false, remoteBusy: false, refreshTick: 0, toasts: [],
  });
});

it("offers to push a newly completed commit while its sidebar refresh is still pending", async () => {
  let resolveRefs!: (value: Awaited<ReturnType<typeof api.remoteBranches>>) => void;
  const refs = new Promise<Awaited<ReturnType<typeof api.remoteBranches>>>((resolve) => { resolveRefs = resolve; });
  vi.spyOn(api, "remoteBranches").mockReturnValue(refs);
  vi.spyOn(api, "branches").mockResolvedValue({ branches: [{ ...BRANCH, shortHash: "bbb", ahead: 1 }] });
  vi.spyOn(api, "commits").mockResolvedValue({ commits: [], hasMore: false });
  vi.spyOn(api, "remotes").mockResolvedValue({ remotes: [] });
  vi.spyOn(api, "stashes").mockResolvedValue({ stashes: [] });
  vi.spyOn(api, "worktrees").mockResolvedValue({ worktrees: [] });
  vi.spyOn(useStore.getState(), "loadMergeState").mockResolvedValue();
  vi.spyOn(api, "commit").mockResolvedValue({ hash: "bbb", repo: { ...REPO, head: "bbb" }, status: { staged: [], unstaged: [] } });
  const choice = vi.spyOn(useStore.getState(), "requestChoice").mockResolvedValue("cancel");

  await useStore.getState().commit("next", "", false);
  const result = await useStore.getState().ensureBranchPushed("feature");
  resolveRefs({ branches: [] });
  for (let i = 0; i < 20; i += 1) await Promise.resolve();

  expect(choice).toHaveBeenCalledTimes(1);
  expect(result.ok).toBe(false);
});

it("checks the pushed branch directly when the sidebar still shows unpushed commits", async () => {
  const unpushed = { ...BRANCH, ahead: 1 };
  useStore.setState({ branches: [unpushed] });
  vi.spyOn(api, "branches")
    .mockResolvedValueOnce({ branches: [unpushed] })
    .mockResolvedValueOnce({ branches: [BRANCH] });
  vi.spyOn(useStore.getState(), "requestChoice").mockResolvedValue("push");
  const push = vi.spyOn(useStore.getState(), "push").mockResolvedValue();

  expect(await useStore.getState().ensureBranchPushed("feature")).toEqual({ ok: true });
  expect(push).toHaveBeenCalledTimes(1);
  expect(useStore.getState().branches).toEqual([unpushed]);
});

it.each([
  { ...REPO, root: "C:/repos/other" },
  { ...REPO, branch: "other" },
])("does not prompt or push after the active target changes to $root $branch", async (repo) => {
  let resolve!: (value: { branches: Branch[] }) => void;
  vi.spyOn(api, "branches").mockReturnValue(new Promise((done) => { resolve = done; }));
  const choice = vi.spyOn(useStore.getState(), "requestChoice").mockResolvedValue("push");
  const push = vi.spyOn(useStore.getState(), "push").mockResolvedValue();

  const checking = useStore.getState().ensureBranchPushed("feature");
  useStore.setState({ repo });
  resolve({ branches: [{ ...BRANCH, ahead: 1 }] });

  expect((await checking).ok).toBe(false);
  expect(choice).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it("does not accept a push check after leaving and returning to the same target", async () => {
  let resolve!: (value: { branches: Branch[] }) => void;
  vi.spyOn(api, "branches").mockReturnValue(new Promise((done) => { resolve = done; }));
  const choice = vi.spyOn(useStore.getState(), "requestChoice").mockResolvedValue("push");
  const push = vi.spyOn(useStore.getState(), "push").mockResolvedValue();

  const checking = useStore.getState().ensureBranchPushed("feature");
  useStore.getState().newTab();
  useStore.setState({ repo: REPO, activeTabId: "mutation-refresh" });
  resolve({ branches: [BRANCH] });

  expect((await checking).ok).toBe(false);
  expect(choice).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it("propagates a failed preflight read without prompting or pushing", async () => {
  vi.spyOn(api, "branches").mockRejectedValue(new Error("cannot read refs"));
  const choice = vi.spyOn(useStore.getState(), "requestChoice").mockResolvedValue("push");
  const push = vi.spyOn(useStore.getState(), "push").mockResolvedValue();

  await expect(useStore.getState().ensureBranchPushed("feature")).rejects.toThrow("cannot read refs");
  expect(choice).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it.each(["feature", "other"])("accepts the already pushed %s branch without a prompt", async (branch) => {
  vi.spyOn(api, "branches").mockResolvedValue({ branches: [{ ...BRANCH, name: branch, current: branch === REPO.branch }] });
  const choice = vi.spyOn(useStore.getState(), "requestChoice").mockResolvedValue("push");
  const push = vi.spyOn(useStore.getState(), "push").mockResolvedValue();

  expect(await useStore.getState().ensureBranchPushed(branch)).toEqual({ ok: true });
  expect(choice).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it("requires checkout before pushing a noncurrent unpushed branch", async () => {
  vi.spyOn(api, "branches").mockResolvedValue({ branches: [{ ...BRANCH, name: "other", current: false, ahead: 1 }] });
  const choice = vi.spyOn(useStore.getState(), "requestChoice").mockResolvedValue("push");
  const push = vi.spyOn(useStore.getState(), "push").mockResolvedValue();

  const result = await useStore.getState().ensureBranchPushed("other");
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("Check it out");
  expect(choice).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});
