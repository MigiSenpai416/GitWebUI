import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Commit, RepoInfo } from "../types";
import { useStore } from "./store";

const REPO: RepoInfo = { root: "C:/repos/graph", branch: "main", head: "head" };
const COMMITS: Commit[] = [{
  hash: "head",
  shortHash: "head",
  parents: [],
  author: "Ann",
  email: "ann@example.com",
  dateISO: "2026-01-01T00:00:00Z",
  subject: "Head",
  body: "",
  refs: [],
}];

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.restoreAllMocks();
  useStore.setState({
    repo: REPO,
    commits: COMMITS,
    graphMode: "linear",
    selectedCommitHash: "head",
    visibleRefs: ["refs/heads/feature"],
  });
});

describe("commit graph mode", () => {
  it("defaults to the lightweight linear renderer", () => {
    expect(useStore.getInitialState().graphMode).toBe("linear");
  });

  it("persists per repository without reloading or replacing history", () => {
    const commits = vi.spyOn(api, "commits");

    useStore.getState().setGraphMode("full");

    expect(useStore.getState()).toMatchObject({
      graphMode: "full",
      commits: COMMITS,
      selectedCommitHash: "head",
      visibleRefs: ["refs/heads/feature"],
    });
    expect(commits).not.toHaveBeenCalled();
    expect(JSON.parse(values.get("gwui.graphMode") ?? "{}")).toEqual({
      [REPO.root]: "full",
    });

    useStore.setState({ repo: { ...REPO, root: "C:/repos/other" }, graphMode: "linear" });
    useStore.getState().setGraphMode("full");
    expect(JSON.parse(values.get("gwui.graphMode") ?? "{}")).toEqual({
      [REPO.root]: "full",
      "C:/repos/other": "full",
    });
  });
});
