import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore, type RepoTab } from "../../web/src/state/store.js";
import type { ApiReply, DesktopBridge } from "../../web/src/desktop.js";

interface PendingOpen {
  resolve: (reply: ApiReply) => void;
}

type Call = DesktopBridge["call"];

/** Stand in for the preload bridge the web client calls the core through. */
function stubBridge(call: Call): void {
  vi.stubGlobal("window", { gitwebui: { call, cancel: () => undefined } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("repository tab navigation", () => {
  it("ignores an older open response after a newer tab selection wins", async () => {
    const tabs: RepoTab[] = [
      { id: "one", root: "C:\\repos\\one", name: "one", branch: "main" },
      { id: "two", root: "C:\\repos\\two", name: "two", branch: "main" },
    ];
    useStore.setState({ tabs, activeTabId: "one", repo: null, opening: false });

    const pending = new Map<string, PendingOpen>();
    stubBridge(async (_id, route, input) => {
      if (route === "openRepo") {
        const root = String((input as { path: string }).path);
        return await new Promise<ApiReply>((resolve) => pending.set(root, { resolve }));
      }
      // Hydration calls read different properties from the same harmless
      // empty payload; including all of them keeps this test focused on ordering.
      return json({
        branches: [],
        commits: [],
        hasMore: false,
        staged: [],
        unstaged: [],
        remotes: [],
        stashes: [],
        worktrees: [],
        merge: { active: false, kind: null, conflicted: [] },
      });
    });

    const first = useStore.getState().selectTab("one");
    const second = useStore.getState().selectTab("two");

    pending.get("C:\\repos\\two")!.resolve(
      json({ repo: { root: "C:\\repos\\two", branch: "main", head: null } }),
    );
    await second;

    pending.get("C:\\repos\\one")!.resolve(
      json({ repo: { root: "C:\\repos\\one", branch: "main", head: null } }),
    );
    await first;

    const state = useStore.getState();
    expect(state.activeTabId).toBe("two");
    expect(state.repo?.root).toBe("C:\\repos\\two");
    expect(state.opening).toBe(false);
  });

  it("does not let an old hydration response overwrite the new repository", async () => {
    const tabs: RepoTab[] = [
      { id: "one", root: "C:\\repos\\one", name: "one", branch: "main" },
      { id: "two", root: "C:\\repos\\two", name: "two", branch: "main" },
    ];
    useStore.setState({
      tabs,
      activeTabId: "one",
      repo: null,
      opening: false,
      loadingCommits: false,
      loadingStatus: false,
    });

    let resolveOldBranches: ((reply: ApiReply) => void) | null = null;
    stubBridge(async (_id, route, input, root) => {
      if (route === "openRepo") {
        const openedRoot = String((input as { path: string }).path);
        return json({ repo: { root: openedRoot, branch: "main", head: null } });
      }
      if (route === "branches") {
        if (root === "C:\\repos\\one") {
          return await new Promise<ApiReply>((resolve) => {
            resolveOldBranches = resolve;
          });
        }
        return json({ branches: [branch("two-branch")] });
      }
      return json({
        branches: [],
        commits: [],
        hasMore: false,
        staged: [],
        unstaged: [],
        remotes: [],
        stashes: [],
        worktrees: [],
        merge: { active: false, kind: null, conflicted: [] },
      });
    });

    const first = useStore.getState().selectTab("one");
    await vi.waitFor(() => expect(resolveOldBranches).not.toBeNull());
    await useStore.getState().selectTab("two");
    expect(useStore.getState().branches.map((b) => b.name)).toEqual(["two-branch"]);

    resolveOldBranches!(json({ branches: [branch("stale-one-branch")] }));
    await first;

    const state = useStore.getState();
    expect(state.repo?.root).toBe("C:\\repos\\two");
    expect(state.branches.map((b) => b.name)).toEqual(["two-branch"]);
  });
});

function branch(name: string) {
  return {
    name,
    current: true,
    shortHash: "0000000",
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
  };
}

function json(body: unknown): ApiReply {
  return { ok: true, json: JSON.stringify(body) };
}
