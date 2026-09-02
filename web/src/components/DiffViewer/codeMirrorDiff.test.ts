import { describe, expect, it } from "vitest";
import type { DiffRow } from "../../types";
import {
  computeIntralineDiff,
  computeIntralineRanges,
  sameDiffRows,
  splitDiffRows,
} from "./codeMirrorDiff";

function highlightedText(text: string, ranges: Array<{ from: number; to: number }>): string[] {
  return ranges.map((range) => text.slice(range.from, range.to));
}

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

describe("computeIntralineRanges", () => {
  it("highlights separate changed words while leaving shared text unaccented", () => {
    const rows: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: "const color = red; const size = small;" },
      { type: "add", oldNo: null, newNo: 1, text: "const color = green; const size = large;" },
    ];

    const ranges = computeIntralineRanges(rows);

    expect(highlightedText(rows[0].text, ranges[0])).toEqual(["red", "small"]);
    expect(highlightedText(rows[1].text, ranges[1])).toEqual(["green", "large"]);
  });

  it("narrows a changed token to the differing characters", () => {
    const rows: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: "version10" },
      { type: "add", oldNo: null, newNo: 1, text: "version11" },
    ];

    const ranges = computeIntralineRanges(rows);

    expect(highlightedText(rows[0].text, ranges[0])).toEqual(["0"]);
    expect(highlightedText(rows[1].text, ranges[1])).toEqual(["1"]);
  });

  it.each([
    ["status: 😀", "status: 😃", "😀", "😃"],
    ["tone: 👍🏻", "tone: 👍🏽", "👍🏻", "👍🏽"],
    ["role: 👩‍💻", "role: 👩‍🔬", "👩‍💻", "👩‍🔬"],
    ["mark: e\u0301", "mark: e\u0300", "e\u0301", "e\u0300"],
  ])("keeps changed grapheme clusters intact", (oldText, newText, oldChanged, newChanged) => {
    const rows: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: oldText },
      { type: "add", oldNo: null, newNo: 1, text: newText },
    ];

    const ranges = computeIntralineRanges(rows);

    expect(highlightedText(rows[0].text, ranges[0])).toEqual([oldChanged]);
    expect(highlightedText(rows[1].text, ranges[1])).toEqual([newChanged]);
  });

  it("only pairs replacement lines inside the same change run", () => {
    const rows: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: "before" },
      { type: "add", oldNo: null, newNo: 1, text: "after" },
      { type: "context", oldNo: 2, newNo: 2, text: "shared" },
      { type: "add", oldNo: null, newNo: 3, text: "new line" },
    ];

    const ranges = computeIntralineRanges(rows);

    expect(ranges[0]).not.toHaveLength(0);
    expect(ranges[1]).not.toHaveLength(0);
    expect(ranges[2]).toEqual([]);
    expect(ranges[3]).toEqual([]);
  });

  it("uses aligned counterpart rows in the split layout", () => {
    const rows: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: "hello old world" },
      { type: "context", oldNo: 2, newNo: null, text: "" },
    ];
    const counterparts: DiffRow[] = [
      { type: "add", oldNo: null, newNo: 1, text: "hello new world" },
      { type: "add", oldNo: null, newNo: 2, text: "another line" },
    ];

    const ranges = computeIntralineRanges(rows, counterparts);

    expect(highlightedText(rows[0].text, ranges[0])).toEqual(["old"]);
    expect(ranges[1]).toEqual([]);
  });

  it("matches similar lines across an uneven replacement block", () => {
    const rows: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: "obsolete unrelated setting" },
      { type: "del", oldNo: 2, newNo: null, text: "const color = red;" },
      { type: "add", oldNo: null, newNo: 1, text: "const color = green;" },
    ];

    const ranges = computeIntralineRanges(rows);
    const split = splitDiffRows(rows);

    expect(ranges[0]).toEqual([]);
    expect(highlightedText(rows[1].text, ranges[1])).toEqual(["red"]);
    expect(highlightedText(rows[2].text, ranges[2])).toEqual(["green"]);
    expect(split.oldHighlights[0]).toEqual([]);
    expect(highlightedText(split.oldRows[1].text, split.oldHighlights[1])).toEqual(["red"]);
    expect(split.newRows[0].placeholder).toBe(true);
    expect(highlightedText(split.newRows[1].text, split.newHighlights[1])).toEqual(["green"]);
  });

  it("skips unusually large lines without suppressing later highlights", () => {
    const prefix = "same ".repeat(3_000);
    const suffix = " tail".repeat(3_000);
    const rows: DiffRow[] = [
      { type: "del", oldNo: 1, newNo: null, text: `${prefix}old${suffix}` },
      { type: "add", oldNo: null, newNo: 1, text: `${prefix}new${suffix}` },
      { type: "context", oldNo: 2, newNo: 2, text: "shared" },
      { type: "del", oldNo: 3, newNo: null, text: "color: red" },
      { type: "add", oldNo: null, newNo: 3, text: "color: green" },
    ];

    const ranges = computeIntralineRanges(rows);

    expect(ranges[0]).toEqual([]);
    expect(ranges[1]).toEqual([]);
    expect(highlightedText(rows[3].text, ranges[3])).toEqual(["red"]);
    expect(highlightedText(rows[4].text, ranges[4])).toEqual(["green"]);
  });

  it("bounds detailed comparisons across the whole diff", () => {
    const oldWords = Array.from({ length: 100 }, (_, index) => `word${index}`);
    const newWords = [...oldWords];
    oldWords[10] = "beforeFirst";
    oldWords[90] = "beforeLast";
    newWords[10] = "afterFirst";
    newWords[90] = "afterLast";
    const oldText = oldWords.join(" ");
    const newText = newWords.join(" ");
    const rows: DiffRow[] = [
      ...Array.from({ length: 30 }, (_, index) => ({
        type: "del" as const,
        oldNo: index + 1,
        newNo: null,
        text: oldText,
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        type: "add" as const,
        oldNo: null,
        newNo: index + 1,
        text: newText,
      })),
    ];

    const ranges = computeIntralineRanges(rows);

    expect(ranges[0]).toHaveLength(2);
    expect(ranges[29]).toHaveLength(1);
    expect(ranges[59]).toHaveLength(1);
  });

  it("keeps large replacement blocks highlighted with bounded line alignment", () => {
    const rows: DiffRow[] = [
      ...Array.from({ length: 51 }, (_, index) => ({
        type: "del" as const,
        oldNo: index + 1,
        newNo: null,
        text: `key${index} = old`,
      })),
      ...Array.from({ length: 51 }, (_, index) => ({
        type: "add" as const,
        oldNo: null,
        newNo: index + 1,
        text: `key${index} = new`,
      })),
    ];

    const ranges = computeIntralineRanges(rows);
    const split = splitDiffRows(rows);

    expect(ranges.filter((range) => range.length > 0)).toHaveLength(102);
    expect(split.oldHighlights.filter((range) => range.length > 0)).toHaveLength(51);
    expect(split.newHighlights.filter((range) => range.length > 0)).toHaveLength(51);
    expect(highlightedText(rows[50].text, ranges[50])).toEqual(["old"]);
    expect(highlightedText(rows[101].text, ranges[101])).toEqual(["new"]);
  });

  it("looks ahead before pairing a similar inserted line in a large block", () => {
    const rows: DiffRow[] = [
      ...Array.from({ length: 51 }, (_, index) => ({
        type: "del" as const,
        oldNo: index + 1,
        newNo: null,
        text: `const key${index} = old${index};`,
      })),
      { type: "add" as const, oldNo: null, newNo: 1, text: "const inserted = extra;" },
      ...Array.from({ length: 51 }, (_, index) => ({
        type: "add" as const,
        oldNo: null,
        newNo: index + 2,
        text: `const key${index} = new${index};`,
      })),
    ];

    const intraline = computeIntralineDiff(rows);
    const ranges = intraline.ranges;
    const split = splitDiffRows(rows, intraline);

    expect(highlightedText(rows[0].text, ranges[0])).toEqual(["old"]);
    expect(ranges[51]).toEqual([]);
    expect(highlightedText(rows[52].text, ranges[52])).toEqual(["new"]);
    expect(highlightedText(rows[102].text, ranges[102])).toEqual(["new"]);
    expect(split.oldRows[0].placeholder).toBe(true);
    expect(split.newRows[0].text).toBe("const inserted = extra;");
    expect(split.oldRows[1].text).toBe("const key0 = old0;");
    expect(split.newRows[1].text).toBe("const key0 = new0;");
  });
});
