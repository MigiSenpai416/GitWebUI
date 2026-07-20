import { describe, it, expect } from "vitest";
import { parseLog, parseRefs, sanitizeRevs } from "./log.js";
import { parseStatus } from "./status.js";
import { parseUnifiedDiff } from "./diff.js";
import { parseNameStatus } from "./commitFiles.js";
import { parseBranches, parseRemoteBranches } from "./branches.js";

const US = "\x1f";
const RS = "\x1e";

describe("parseRefs", () => {
  it("parses full-ref HEAD, branches, remotes, and tags (--decorate=full)", () => {
    const refs = parseRefs(
      "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0, refs/heads/feature/x",
    );
    expect(refs).toEqual([
      { name: "main", kind: "branch", isHead: true },
      { name: "origin/main", kind: "remote" },
      { name: "v1.0", kind: "tag" },
      { name: "feature/x", kind: "branch" },
    ]);
  });

  it("handles empty decoration", () => {
    expect(parseRefs("")).toEqual([]);
  });
});

describe("parseLog", () => {
  it("parses separator-delimited commit records", () => {
    const rec1 = ["h1", "h1s", "p0 p1", "Ann", "ann@x.io", "2026-01-01T00:00:00Z", "HEAD -> main", "Subject one", "Body line 1\nBody line 2"].join(US) + RS;
    const rec2 = ["h2", "h2s", "", "Bob", "bob@x.io", "2026-01-02T00:00:00Z", "", "Subject two", ""].join(US) + RS;
    const commits = parseLog(rec1 + "\n" + rec2);
    expect(commits).toHaveLength(2);
    expect(commits[0].hash).toBe("h1");
    expect(commits[0].parents).toEqual(["p0", "p1"]);
    expect(commits[0].subject).toBe("Subject one");
    expect(commits[0].body).toBe("Body line 1\nBody line 2");
    expect(commits[0].refs[0]).toMatchObject({ name: "main", isHead: true });
    expect(commits[1].parents).toEqual([]);
    expect(commits[1].refs).toEqual([]);
  });
});

describe("parseStatus", () => {
  it("splits staged vs unstaged and handles untracked", () => {
    // Ordinary modified-but-staged (M.), worktree-only modified (.M), untracked (?)
    const data =
      "1 M. N... 100644 100644 100644 aaa aaa staged.txt\0" +
      "1 .M N... 100644 100644 100644 bbb bbb worktree.txt\0" +
      "? new.txt\0";
    const res = parseStatus(data);
    expect(res.staged.map((f) => f.path)).toEqual(["staged.txt"]);
    expect(res.unstaged.map((f) => f.path)).toEqual(["worktree.txt", "new.txt"]);
    expect(res.unstaged.find((f) => f.path === "new.txt")?.status).toBe("?");
  });

  it("parses a rename entry consuming the original-path token", () => {
    const data = "2 R. N... 100644 100644 100644 ccc ccc R100 new-name.txt\0old-name.txt\0";
    const res = parseStatus(data);
    expect(res.staged).toHaveLength(1);
    expect(res.staged[0]).toMatchObject({ path: "new-name.txt", status: "R", oldPath: "old-name.txt" });
  });
});

describe("parseUnifiedDiff", () => {
  it("produces ordered rows with correct old/new numbering", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+line2 changed",
      "+line4 added",
      " line3",
      "",
    ].join("\n");
    const { rows, binary } = parseUnifiedDiff(diff);
    expect(binary).toBe(false);
    expect(rows.map((r) => [r.type, r.oldNo, r.newNo, r.text])).toEqual([
      ["context", 1, 1, "line1"],
      ["del", 2, null, "line2"],
      ["add", null, 2, "line2 changed"],
      ["add", null, 3, "line4 added"],
      ["context", 3, 4, "line3"],
    ]);
  });

  it("marks the no-newline row", () => {
    const diff = [
      "--- a/f",
      "+++ b/f",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const { rows } = parseUnifiedDiff(diff);
    expect(rows[0]).toMatchObject({ type: "del", noNewline: true });
    expect(rows[1]).toMatchObject({ type: "add", noNewline: true });
  });

  it("detects binary files", () => {
    const diff = "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
    const { binary } = parseUnifiedDiff(diff);
    expect(binary).toBe(true);
  });
});

describe("parseBranches", () => {
  it("marks the current branch and parses hash + upstream", () => {
    const data =
      ["*", "main", "9ef9033", "origin/main"].join(US) + RS +
      [" ", "feature/enchant-ui", "abc1234", ""].join(US) + RS;
    const branches = parseBranches(data);
    expect(branches).toEqual([
      { name: "main", current: true, shortHash: "9ef9033", upstream: "origin/main" },
      { name: "feature/enchant-ui", current: false, shortHash: "abc1234", upstream: null },
    ]);
  });
});

describe("parseRemoteBranches", () => {
  it("splits remote/short name, keeps nested paths, and skips origin/HEAD", () => {
    const data =
      ["refs/remotes/origin/main", "9ef9033"].join(US) + RS +
      ["refs/remotes/origin/HEAD", "9ef9033"].join(US) + RS +
      ["refs/remotes/origin/feature/enchant-ui", "abc1234"].join(US) + RS +
      ["refs/remotes/upstream/main", "def5678"].join(US) + RS;
    expect(parseRemoteBranches(data)).toEqual([
      { name: "origin/main", remote: "origin", shortName: "main", ref: "refs/remotes/origin/main", shortHash: "9ef9033" },
      {
        name: "origin/feature/enchant-ui",
        remote: "origin",
        shortName: "feature/enchant-ui",
        ref: "refs/remotes/origin/feature/enchant-ui",
        shortHash: "abc1234",
      },
      { name: "upstream/main", remote: "upstream", shortName: "main", ref: "refs/remotes/upstream/main", shortHash: "def5678" },
    ]);
  });
});

describe("sanitizeRevs", () => {
  it("keeps HEAD and refs/heads|remotes, drops anything that could be a flag", () => {
    expect(
      sanitizeRevs(["HEAD", "refs/heads/main", "refs/remotes/origin/x", "--all", "-n", "; rm -rf", "origin/x"]),
    ).toEqual(["HEAD", "refs/heads/main", "refs/remotes/origin/x"]);
  });
  it("de-duplicates and falls back to HEAD when nothing valid remains", () => {
    expect(sanitizeRevs(["HEAD", "HEAD"])).toEqual(["HEAD"]);
    expect(sanitizeRevs(["--evil"])).toEqual(["HEAD"]);
    expect(sanitizeRevs([])).toEqual(["HEAD"]);
  });
});

describe("parseNameStatus", () => {
  it("parses added/modified and rename entries", () => {
    const data = "M\0src/a.ts\0A\0src/b.ts\0R100\0old.ts\0new.ts\0";
    const files = parseNameStatus(data);
    expect(files).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "A" },
      { path: "new.ts", status: "R", oldPath: "old.ts" },
    ]);
  });
});
