import { describe, expect, it } from "vitest";
import { allDirPaths, buildTree, filesUnder } from "./fileTree";

describe("file tree", () => {
  it("groups shared parents, sorts directories first, and preserves file payloads", () => {
    const files = [
      { path: "z.txt", status: "M" },
      { path: "b/sub/two.txt", status: "A" },
      { path: "a/one.txt", status: "D" },
      { path: "b/sub/one.txt", status: "R" },
    ];
    const tree = buildTree(files);
    expect(tree.map((node) => node.path)).toEqual(["a", "b", "z.txt"]);
    expect(allDirPaths(tree)).toEqual(["a", "b", "b/sub"]);
    expect(filesUnder(tree[1])).toEqual(["b/sub/one.txt", "b/sub/two.txt"]);
    expect(tree[2]).toMatchObject({ type: "file", file: files[0] });
  });

  it("keeps same-named directories under different parents separate", () => {
    const tree = buildTree([{ path: "a/src/one" }, { path: "b/src/two" }, { path: "a/src/three" }]);
    expect(filesUnder(tree[0])).toEqual(["a/src/one", "a/src/three"]);
    expect(filesUnder(tree[1])).toEqual(["b/src/two"]);
  });
});
