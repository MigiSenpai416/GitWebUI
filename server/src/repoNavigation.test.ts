import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore, type RepoTab } from "../../web/src/state/store.js";

interface PendingOpen {
  resolve: (response: Response) => void;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/repo/open")) {
        const root = String(JSON.parse(String(init?.body)).path);
        return await new Promise<Response>((resolve) => pending.set(root, { resolve }));
      }
      // Hydration endpoints read different properties from the same harmless
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
    }) as typeof fetch;

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

    let resolveOldBranches: ((response: Response) => void) | null = null;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const root = headers["X-Repo-Root"];
      if (url.endsWith("/api/repo/open")) {
        const openedRoot = String(JSON.parse(String(init?.body)).path);
        return json({ repo: { root: openedRoot, branch: "main", head: null } });
      }
      if (url.endsWith("/api/branches")) {
        if (root === "C:\\repos\\one") {
          return await new Promise<Response>((resolve) => {
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
    }) as typeof fetch;

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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
