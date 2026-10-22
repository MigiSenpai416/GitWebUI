import { describe, expect, it } from "vitest";
import { chunkParts, commitParts, type CommitPart } from "./aiCommitChunks.js";

describe("AI commit diff chunks", () => {
  it("keeps file and hunk boundaries, including rename, binary and mode-only changes", () => {
    const header = "diff --git a/a.txt b/a.txt\nindex abc..def 100644\n--- a/a.txt\n+++ b/a.txt\n";
    const first = "@@ -1,2 +1,2 @@ function one\n-old\n+new\n context\n";
    const second = "@@ -20 +20 @@ function two\n-before\n+after\n\\ No newline at end of file\n";
    const rename = "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n";
    const binary = "diff --git a/pic b/pic\nBinary files a/pic and b/pic differ\n";
    const mode = "diff --git a/run b/run\nold mode 100644\nnew mode 100755\n";
    const parts = commitParts({ diff: header + first + second + rename + binary + mode, files: [], untracked: [] });
    expect(parts).toHaveLength(5);
    expect(parts[0].header).toBe(header);
    expect(parts[1].header).toBe(header);
    expect(parts.slice(0, 2).map((p) => p.hunk! + p.text)).toEqual([first, second]);
    expect(parts.slice(2).map((p) => p.header)).toEqual([rename, binary, mode]);
    expect(chunkParts(parts, 400)!.flat()).toEqual(parts);
  });

  it("preserves all untracked contents and metadata, including empty and binary files", () => {
    const files = [{ path: "empty", status: "?", staged: false }];
    const untracked = [
      { path: "new.txt", kind: "text", content: "diff --git fake\n@@ fake\nnew content\n" },
      { path: "empty", kind: "text", content: "" },
      { path: "binary", kind: "binary", content: null },
    ];
    const parts = commitParts({ diff: "", files, untracked });
    expect(parts.filter((p) => p.kind === "untracked").map((p) => ({ ...JSON.parse(p.header!), content: p.text })))
      .toEqual(untracked.map((p) => ({ ...p, content: p.content ?? "" })));
    expect(parts.filter((p) => p.kind === "status").map((p) => JSON.parse(p.text))).toEqual(files);
  });

  it.each(["+line\n".repeat(3000), "+" + "漢字😀\"\\".repeat(3000)])("splits large hunks without dropping text or breaking Unicode", (text) => {
    const part: CommitPart = { kind: "diff", header: "diff --git a/a b/a\n", hunk: "@@ -1 +1 @@\n", text };
    const groups = chunkParts([part], 1024)!;
    expect(groups.length).toBeGreaterThan(1);
    let offset = 0;
    for (const group of groups) {
      expect(Buffer.byteLength(JSON.stringify(group))).toBeLessThanOrEqual(1024);
      for (const fragment of group) {
        expect(fragment.header).toBe(part.header);
        expect(fragment.hunk).toBe(part.hunk);
        expect(fragment.offset).toBe(offset);
        expect(Buffer.from(fragment.text).toString("utf8")).toBe(fragment.text);
        offset += fragment.text.length;
      }
    }
    expect(groups.flat().map((p) => p.text).join("")).toBe(text);
    const smaller = chunkParts(groups.flat(), 512)!;
    expect(smaller.flat().map((p) => p.text).join("")).toBe(text);
    expect(smaller.flat().at(-1)!.offset! + smaller.flat().at(-1)!.text.length).toBe(text.length);
  });

  it("keeps complete lines when possible and fails explicitly for oversized metadata", () => {
    const part: CommitPart = { kind: "untracked", header: "new.txt", text: "a".repeat(100) + "\n" + "b".repeat(500) };
    expect(chunkParts([part], 256)![0][0].text).toBe("a".repeat(100) + "\n");
    expect(chunkParts([{ kind: "diff", header: "x".repeat(2000), text: "" }], 1024)).toBeNull();
  });

  it("identifies added, removed and context text when a long diff line is split again", () => {
    const text = "-" + "old();".repeat(500) + "\n+" + "new();".repeat(500) + "\n " + "context();".repeat(500) + "\n";
    const groups = chunkParts([{ kind: "diff", header: "file", hunk: "@@ -1,2 +1,2 @@\n", text }], 1024)!;
    for (const fragments of [groups.flat(), chunkParts(groups.flat(), 512)!.flat()]) {
      expect(fragments.map((p) => p.text).join("")).toBe(text);
      for (const fragment of fragments) {
        const offset = fragment.offset!;
        const start = text.lastIndexOf("\n", offset - 1) + 1;
        expect(fragment.lineType).toBe(offset === start ? undefined
          : text[start] === "-" ? "deletion" : text[start] === "+" ? "addition" : "context");
      }
    }
  });
});
