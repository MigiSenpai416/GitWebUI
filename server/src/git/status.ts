import { runGit } from "./gitRunner.js";

export type ChangeStatus = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";

export interface FileChange {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  staged: boolean;
}

export interface StatusResult {
  staged: FileChange[];
  unstaged: FileChange[];
}

function toStatus(code: string): ChangeStatus {
  const c = code.toUpperCase();
  if (c === "M" || c === "A" || c === "D" || c === "R" || c === "C" || c === "T" || c === "U") {
    return c as ChangeStatus;
  }
  return "M";
}

/**
 * Parse `git status --porcelain=v2 -z --untracked-files=all`.
 *
 * Entries are NUL-terminated. Rename/copy (type "2") entries carry the original
 * path as an extra NUL-delimited token, so they consume two tokens.
 */
export function parseStatus(stdout: string): StatusResult {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  // Trailing NUL yields an empty final token; filtering it is safe because no path is empty.
  const tokens = stdout.split("\0").filter((t) => t.length > 0);

  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    const type = line[0];

    if (type === "1") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const rest = splitOrdinary(line);
      const X = rest.xy[0];
      const Y = rest.xy[1];
      if (X !== ".") staged.push({ path: rest.path, status: toStatus(X), staged: true });
      if (Y !== ".") unstaged.push({ path: rest.path, status: toStatus(Y), staged: false });
    } else if (type === "2") {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>  then origPath as next token
      const rest = splitRename(line);
      const origPath = tokens[i + 1] ?? "";
      i += 1; // consume the original-path token
      const X = rest.xy[0];
      const Y = rest.xy[1];
      if (X !== ".") {
        staged.push({ path: rest.path, status: toStatus(X), oldPath: origPath, staged: true });
      }
      if (Y !== ".") {
        unstaged.push({ path: rest.path, status: toStatus(Y), oldPath: origPath, staged: false });
      }
    } else if (type === "u") {
      // Unmerged (conflict): surface under unstaged.
      const rest = splitUnmerged(line);
      unstaged.push({ path: rest.path, status: "U", staged: false });
    } else if (type === "?") {
      unstaged.push({ path: line.slice(2), status: "?", staged: false });
    }
    // type "!" (ignored) is not requested and skipped.
  }

  return { staged, unstaged };
}

// For a type-1 line the path is everything after the 8th space-delimited field.
function splitOrdinary(line: string): { xy: string; path: string } {
  const parts = line.split(" ");
  // fields: 0:"1" 1:XY 2:sub 3:mH 4:mI 5:mW 6:hH 7:hI 8..:path (path may contain spaces)
  const xy = parts[1];
  const path = parts.slice(8).join(" ");
  return { xy, path };
}

// Type-2 line has one extra field (Xscore) before the path.
function splitRename(line: string): { xy: string; path: string } {
  const parts = line.split(" ");
  // fields: 0:"2" 1:XY 2:sub 3:mH 4:mI 5:mW 6:hH 7:hI 8:Xscore 9..:path
  const xy = parts[1];
  const path = parts.slice(9).join(" ");
  return { xy, path };
}

// Type-u line: 0:"u" 1:XY 2:sub 3:m1 4:m2 5:m3 6:mW 7:h1 8:h2 9:h3 10..:path
function splitUnmerged(line: string): { xy: string; path: string } {
  const parts = line.split(" ");
  return { xy: parts[1], path: parts.slice(10).join(" ") };
}

export async function getStatus(root: string): Promise<StatusResult> {
  const { stdout } = await runGit(root, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  return parseStatus(stdout);
}
