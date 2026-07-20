import { describe, it, expect } from "vitest";
import { parseStashList } from "./stash.js";

describe("parseStashList", () => {
  it("parses ref/subject pairs and extracts the index", () => {
    const out =
      "stash@{0}\tWIP on main: 1a2b3c4 Add feature\n" +
      "stash@{1}\tOn feature: custom message\n";
    expect(parseStashList(out)).toEqual([
      { index: 0, ref: "stash@{0}", message: "WIP on main: 1a2b3c4 Add feature" },
      { index: 1, ref: "stash@{1}", message: "On feature: custom message" },
    ]);
  });

  it("returns an empty list when there are no stashes", () => {
    expect(parseStashList("")).toEqual([]);
    expect(parseStashList("\n  \n")).toEqual([]);
  });
});
