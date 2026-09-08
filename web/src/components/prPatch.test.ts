import { describe, expect, it } from "vitest";
import { parsePrPatch } from "./prPatch";

describe("PR diff line anchors", () => {
  it("tracks old and new numbers independently across hunks", () => {
    const rows = parsePrPatch("@@ -10,2 +20,3 @@\n context\n-removed\n+added\n+another\n@@ -50 +80 @@\n-before\n+after");
    expect(rows.map(({ oldLine, newLine }) => [oldLine, newLine])).toEqual([
      [undefined, undefined], [10, 20], [11, undefined], [undefined, 21], [undefined, 22],
      [undefined, undefined], [50, undefined], [undefined, 80],
    ]);
  });
  it("handles new files and no-newline markers without inventing old lines", () => {
    expect(parsePrPatch("@@ -0,0 +1,2 @@\n+one\n\\ No newline at end of file\n+two")).toEqual([
      { text: "@@ -0,0 +1,2 @@" }, { text: "+one", newLine: 1 },
      { text: "\\ No newline at end of file" }, { text: "+two", newLine: 2 },
    ]);
  });
  it("does not create anchors for metadata or malformed hunk tails", () => {
    expect(parsePrPatch("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n+extra").at(-1)).toEqual({ text: "+extra" });
    expect(parsePrPatch("+without a hunk")[0].newLine).toBeUndefined();
  });
});
