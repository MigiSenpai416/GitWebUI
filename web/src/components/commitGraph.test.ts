import { describe, expect, it } from "vitest";
import { layoutCommitGraph } from "./commitGraph";

function commit(hash: string, parents: string[] = []) {
  return { hash, parents };
}

describe("layoutCommitGraph", () => {
  it("keeps a linear history in one lane", () => {
    const layout = layoutCommitGraph([
      commit("c3", ["c2"]),
      commit("c2", ["c1"]),
      commit("c1"),
    ]);

    expect(layout.maxLanes).toBe(1);
    expect(layout.rows.map((row) => row.nodeLane)).toEqual([0, 0, 0]);
    expect(layout.rows[0].segments).toEqual([
      expect.objectContaining({ kind: "parent", fromLane: 0, toLane: 0, parentHash: "c2" }),
    ]);
  });

  it("opens and rejoins both sides of a merge", () => {
    const layout = layoutCommitGraph([
      commit("merge", ["main", "branch"]),
      commit("main", ["root"]),
      commit("branch", ["root"]),
      commit("root"),
    ]);

    expect(layout.maxLanes).toBe(2);
    expect(layout.rows.map((row) => row.nodeLane)).toEqual([0, 0, 1, 0]);
    expect(layout.rows[0].segments.filter((edge) => edge.kind === "parent")).toEqual([
      expect.objectContaining({ fromLane: 0, toLane: 0, parentHash: "main" }),
      expect.objectContaining({ fromLane: 0, toLane: 1, parentHash: "branch" }),
    ]);
    expect(layout.rows[2].segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "continuation", fromLane: 0, toLane: 0 }),
      expect.objectContaining({ kind: "parent", fromLane: 1, toLane: 0, parentHash: "root" }),
    ]));
  });

  it("routes every octopus merge parent exactly once", () => {
    const layout = layoutCommitGraph([
      commit("merge", ["a", "b", "c", "d"]),
      commit("a", ["root"]),
      commit("b", ["root"]),
      commit("c", ["root"]),
      commit("d", ["root"]),
      commit("root"),
    ]);
    const parentEdges = layout.rows[0].segments.filter((edge) => edge.kind === "parent");

    expect(layout.maxLanes).toBe(4);
    expect(parentEdges.map((edge) => edge.parentHash)).toEqual(["a", "b", "c", "d"]);
    expect(new Set(parentEdges.map((edge) => edge.toLane)).size).toBe(4);
  });

  it("adds an unmerged selected tip without connecting adjacent rows", () => {
    const layout = layoutCommitGraph([
      commit("main", ["root"]),
      commit("feature", ["root"]),
      commit("root"),
    ]);

    expect(layout.rows.map((row) => row.nodeLane)).toEqual([0, 1, 0]);
    expect(layout.rows[1].segments).not.toContainEqual(
      expect.objectContaining({ kind: "incoming", fromLane: 1 }),
    );
    expect(layout.rows[1].segments).toContainEqual(
      expect.objectContaining({ kind: "parent", fromLane: 1, toLane: 0, parentHash: "root" }),
    );
  });

  it("keeps existing rows stable when another page is appended", () => {
    const firstPage = [
      commit("merge", ["main", "branch"]),
      commit("main", ["root"]),
    ];
    const nextPage = [commit("branch", ["root"]), commit("root")];
    const firstLayout = layoutCommitGraph(firstPage);
    const completeLayout = layoutCommitGraph([...firstPage, ...nextPage]);

    expect(completeLayout.rows.slice(0, firstPage.length)).toEqual(firstLayout.rows);
    expect(firstLayout.rows[1].segments).toContainEqual(
      expect.objectContaining({ kind: "parent", parentHash: "root" }),
    );
  });

  it("deduplicates malformed repeated parents", () => {
    const layout = layoutCommitGraph([
      commit("merge", ["parent", "parent", "merge", ""]),
      commit("parent"),
    ]);

    expect(layout.rows[0].segments.filter((edge) => edge.kind === "parent")).toEqual([
      expect.objectContaining({ parentHash: "parent" }),
    ]);
    expect(layout.maxLanes).toBe(1);
  });

  it("keeps every loaded prefix stable for a dense deterministic DAG", () => {
    const commits = Array.from({ length: 36 }, (_, index) => {
      const parents: string[] = [];
      if (index + 1 < 36) parents.push(`c${index + 1}`);
      if (index % 4 === 0 && index + 3 < 36) parents.push(`c${index + 3}`);
      if (index % 9 === 0 && index + 7 < 36) parents.push(`c${index + 7}`);
      return commit(`c${index}`, parents);
    });
    const complete = layoutCommitGraph(commits);

    for (let length = 1; length <= commits.length; length += 1) {
      const prefix = layoutCommitGraph(commits.slice(0, length));
      expect(complete.rows.slice(0, length)).toEqual(prefix.rows);
    }
    for (let index = 0; index < commits.length; index += 1) {
      const parentEdges = complete.rows[index].segments
        .filter((edge) => edge.kind === "parent")
        .map((edge) => edge.parentHash);
      expect(parentEdges).toEqual(Array.from(new Set(commits[index].parents)));
    }
  });
});
