import { describe, expect, it } from "vitest";
import type { DiffRow } from "../../types";
import { sameDiffRows, splitDiffRows } from "./codeMirrorDiff";

describe("splitDiffRows", () => {
  it("aligns replacements and duplicates context on both sides", () => {
    const rows: DiffRow[] = [
      { type: "context", oldNo: 10, newNo: 10, text: "shared before" },
      { type: "del", oldNo: 11, newNo: null, text: "old one" },
      { type: "del", oldNo: 12, newNo: null, text: "old two" },
      { type: "add", oldNo: null, newNo: 11, text: "new one" },
      { type: "context", oldNo: 13, newNo: 12, text: "shared after" },
    ];

    const split = splitDiffRows(rows);

    expect(split.hunkStarts).toEqual([2]);
    expect(split.oldRows.map((row) => row.text)).toEqual([
      "shared before",
      "old one",
      "old two",
      "shared after",
    ]);
    expect(split.newRows.map((row) => row.text)).toEqual([
      "shared before",
      "new one",
      "",
      "shared after",
    ]);
    expect(split.newRows[2].placeholder).toBe(true);
    expect(split.oldRows[1].type).toBe("del");
    expect(split.newRows[1].type).toBe("add");
  });

  it("keeps separate change runs navigable at their aligned line numbers", () => {
    const rows: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: "removed" },
      { type: "context", oldNo: 2, newNo: 1, text: "middle" },
      { type: "add", oldNo: null, newNo: 2, text: "added" },
    ];

    const split = splitDiffRows(rows);

    expect(split.hunkStarts).toEqual([1, 3]);
    expect(split.oldRows).toHaveLength(split.newRows.length);
    expect(split.oldRows[0].placeholder).toBeUndefined();
    expect(split.newRows[0].placeholder).toBe(true);
    expect(split.oldRows[2].placeholder).toBe(true);
    expect(split.newRows[2].placeholder).toBeUndefined();
  });

  it("distinguishes a placeholder from a real blank changed line", () => {
    const withPlaceholder: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: "a" },
      { type: "context", oldNo: 2, newNo: 1, text: "b" },
    ];
    const withBlankAddition: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: "a" },
      { type: "add", oldNo: null, newNo: 1, text: "" },
      { type: "context", oldNo: 2, newNo: 2, text: "b" },
    ];
    const previous = splitDiffRows(withPlaceholder);
    const current = splitDiffRows(withBlankAddition);

    expect(previous.oldRows.map((row) => row.text).join("\n")).toBe(
      current.oldRows.map((row) => row.text).join("\n"),
    );
    expect(previous.newRows.map((row) => row.text).join("\n")).toBe(
      current.newRows.map((row) => row.text).join("\n"),
    );
    expect(sameDiffRows(withPlaceholder, withBlankAddition)).toBe(false);
  });
});
