import { runGit, GitError } from "./gitRunner.js";
import { languageForPath } from "./language.js";

export type RowType = "context" | "add" | "del";

export interface DiffRow {
  type: RowType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** True when the row is the "\ No newline at end of file" marker's target line. */
  noNewline?: boolean;
}

export interface DiffResult {
  path: string;
  oldPath: string | null;
  rows: DiffRow[];
  language: string;
  binary: boolean;
  /** Working-tree / new-side content used by "File View"; null when unavailable. */
  fileContent: string | null;
  /** True when git reports no differences (identical / unchanged). */
  empty: boolean;
}

export type DiffSource = "unstaged" | "staged" | "commit";

// Effectively-infinite context so git emits the whole file as a single hunk.
const FULL_CONTEXT = "-U1000000";

/**
 * Parse a unified diff (produced with a huge -U context) into ordered rows that
 * cover the entire file. `del` rows precede their paired `add` rows, exactly as
 * git emits them, so the joined text renders as an inline diff.
 */
export function parseUnifiedDiff(diff: string): { rows: DiffRow[]; binary: boolean; oldPath: string | null } {
  const rows: DiffRow[] = [];
  let binary = false;
  let oldPath: string | null = null;
  const lines = diff.split("\n");
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      oldPath = p === "/dev/null" ? null : stripPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      continue;
    }
    if (line.startsWith("diff --git") || line.startsWith("index ") ||
        line.startsWith("new file") || line.startsWith("deleted file") ||
        line.startsWith("similarity ") || line.startsWith("rename ") ||
        line.startsWith("old mode") || line.startsWith("new mode") ||
        line.startsWith("copy ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — annotate the most recent content row.
      if (rows.length > 0) rows[rows.length - 1].noNewline = true;
      continue;
    }
    // The very last split segment can be an empty string from a trailing newline.
    if (line === "" && i === lines.length - 1) continue;

    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      rows.push({ type: "add", oldNo: null, newNo: newNo++, text });
    } else if (marker === "-") {
      rows.push({ type: "del", oldNo: oldNo++, newNo: null, text });
    } else {
      // context line (leading space); empty leftover lines are treated as context too
      rows.push({ type: "context", oldNo: oldNo++, newNo: newNo++, text });
    }
  }

  return { rows, binary, oldPath };
}

function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function diffArgs(source: DiffSource, hash: string | undefined, path: string): string[] {
  switch (source) {
    case "unstaged":
      return ["diff", "--no-color", FULL_CONTEXT, "--", path];
    case "staged":
      return ["diff", "--cached", "--no-color", FULL_CONTEXT, "--", path];
    case "commit":
      if (!hash) throw new Error("commit diff requires a hash");
      return ["show", "--no-color", "--first-parent", FULL_CONTEXT, "--format=", hash, "--", path];
  }
}

export async function getDiff(
  root: string,
  source: DiffSource,
  path: string,
  hash?: string,
): Promise<DiffResult> {
  const { stdout } = await runGit(root, diffArgs(source, hash, path));
  let { rows, binary, oldPath } = parseUnifiedDiff(stdout);

  let fileContent: string | null = null;
  if (!binary) {
    fileContent = await readSideContent(root, source, path, hash);
  }

  // Untracked files never appear in `git diff`; synthesize an all-add diff.
  if (source === "unstaged" && rows.length === 0 && !binary && (await isUntracked(root, path))) {
    if (fileContent !== null && looksBinary(fileContent)) {
      binary = true;
    } else if (fileContent !== null) {
      rows = allAddRows(fileContent);
    }
  }

  return {
    path,
    oldPath: oldPath && oldPath !== path ? oldPath : null,
    rows,
    language: languageForPath(path),
    binary,
    fileContent,
    empty: rows.length === 0 && !binary,
  };
}

async function isUntracked(root: string, path: string): Promise<boolean> {
  try {
    await runGit(root, ["ls-files", "--error-unmatch", "--", path]);
    return false; // tracked
  } catch {
    return true;
  }
}

function looksBinary(content: string): boolean {
  // A NUL byte in the first chunk is git's own heuristic for "binary".
  return content.slice(0, 8000).indexOf(String.fromCharCode(0)) !== -1;
}

function allAddRows(content: string): DiffRow[] {
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = text.length === 0 ? [] : text.split("\n");
  return lines.map((line, idx) => ({
    type: "add" as RowType,
    oldNo: null,
    newNo: idx + 1,
    text: line,
  }));
}

/** Content for the "File View" toggle: the new/working-tree side of the file. */
async function readSideContent(
  root: string,
  source: DiffSource,
  path: string,
  hash?: string,
): Promise<string | null> {
  try {
    if (source === "commit" && hash) {
      const { stdout } = await runGit(root, ["show", `${hash}:${path}`]);
      return stdout;
    }
    if (source === "staged") {
      // New side = the staged (index) blob.
      const { stdout } = await runGit(root, ["show", `:${path}`]);
      return stdout;
    }
    // unstaged: new side = the working-tree file on disk (tracked or untracked).
    const fs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const abs = nodePath.join(root, path);
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if (err instanceof GitError) return null;
    return null;
  }
}
