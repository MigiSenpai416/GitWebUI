import { describe, expect, it } from "vitest";
import type { BlameLine } from "../types";
import { blameChunkOffsets } from "./blameCodeMirror";

function line(lineNumber: number, commitHash: string): BlameLine {
  return {
    lineNumber,
    originalLine: lineNumber,
    commitHash,
    originalPath: "file.ts",
    previousHash: null,
    previousPath: null,
    text: `line ${lineNumber}`,
  };
}

describe("blame chunk annotations", () => {
  it("restarts offsets whenever neighboring lines come from another commit", () => {
    expect(blameChunkOffsets([
      line(1, "a"),
      line(2, "a"),
      line(3, "b"),
      line(4, "a"),
      line(5, "a"),
    ])).toEqual([0, 1, 0, 0, 1]);
  });
});
