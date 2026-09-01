import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { RepoTab } from "./store";
import { useStore } from "./store";

const TABS: RepoTab[] = [
  { id: "a", root: "C:/repos/a", name: "a", branch: "main" },
  { id: "b", root: "C:/repos/b", name: "b", branch: "main" },
  { id: "c", root: "C:/repos/c", name: "c", branch: "main" },
];

const values = new Map<string, string>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  useStore.setState({ tabs: TABS.map((tab) => ({ ...tab })), activeTabId: "b" });
});

describe("tab order", () => {
  it("moves a tab to either side of another tab and keeps the active tab selected", () => {
    useStore.getState().moveTab("a", "b", "after");
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(["b", "a", "c"]);
    expect(useStore.getState().activeTabId).toBe("b");

    useStore.getState().moveTab("c", "b", "before");
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(["c", "b", "a"]);
  });

  it("persists the reordered tabs with the active tab id", () => {
    useStore.getState().moveTab("c", "a", "before");

    expect(JSON.parse(values.get("gwui.tabs") ?? "{}"))
      .toEqual({ tabs: [TABS[2], TABS[0], TABS[1]], activeTabId: "b" });
  });

  it("does not overwrite a drag reorder when a worktree finishes opening", async () => {
    const opened = deferred<Awaited<ReturnType<typeof api.openRepo>>>();
    vi.spyOn(api, "openRepo").mockImplementation(() => opened.promise);
    vi.spyOn(api, "remoteBranches").mockResolvedValue({ branches: [] });
    vi.spyOn(api, "branches").mockResolvedValue({ branches: [] });
    vi.spyOn(api, "commits").mockResolvedValue({ commits: [], hasMore: false });
    vi.spyOn(api, "status").mockResolvedValue({ staged: [], unstaged: [] });
    vi.spyOn(api, "remotes").mockResolvedValue({ remotes: [] });
    vi.spyOn(api, "stashes").mockResolvedValue({ stashes: [] });
    vi.spyOn(api, "mergeState").mockResolvedValue({
      merge: {
        active: false,
        kind: null,
        intoBranch: "main",
        fromLabel: null,
        conflicted: [],
        message: "",
      },
    });
    vi.spyOn(api, "worktrees").mockResolvedValue({ worktrees: [] });
    vi.spyOn(api, "recent").mockResolvedValue({ recent: [] });

    useStore.setState({ activeTabId: "a" });
    const opening = useStore.getState().openWorktree("C:/repos/worktree");
    useStore.getState().moveTab("c", "a", "before");
    opened.resolve({
      repo: { root: "C:/repos/worktree", branch: "feature", head: "head" },
    });
    await opening;

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(["c", "a", "b"]);
    expect(useStore.getState().tabs[1]).toMatchObject({
      id: "a",
      root: "C:/repos/worktree",
      branch: "feature",
    });
    expect(JSON.parse(values.get("gwui.tabs") ?? "{}").tabs.map((tab: RepoTab) => tab.id))
      .toEqual(["c", "a", "b"]);
  });

  it("ignores missing tabs and self-targeted moves", () => {
    useStore.getState().moveTab("a", "a", "after");
    useStore.getState().moveTab("missing", "b", "before");
    useStore.getState().moveTab("a", "missing", "after");

    expect(useStore.getState().tabs).toEqual(TABS);
    expect(values.has("gwui.tabs")).toBe(false);
  });
});
