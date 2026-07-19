import { runGit } from "./gitRunner.js";
import type { ChangeStatus } from "./status.js";

export interface CommitFile {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
}

/**
 * Files changed in a commit vs its first parent, via `--name-status -z`.
 * With -z, rename/copy entries emit status then oldPath then newPath as
 * separate NUL-delimited tokens.
 */
export function parseNameStatus(stdout: string): CommitFile[] {
  const files: CommitFile[] = [];
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    const letter = code[0]?.toUpperCase() as ChangeStatus | undefined;
    if (!letter) continue;
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      i += 2;
      files.push({ path: newPath, status: letter, oldPath });
    } else {
      const p = tokens[i + 1] ?? "";
      i += 1;
      files.push({ path: p, status: normalize(letter) });
    }
  }
  return files;
}

function normalize(code: string): ChangeStatus {
  const c = code.toUpperCase();
  if (c === "M" || c === "A" || c === "D" || c === "T") return c as ChangeStatus;
  return "M";
}

export async function getCommitFiles(root: string, hash: string): Promise<CommitFile[]> {
  const { stdout } = await runGit(root, [
    "show",
    "--first-parent",
    "--name-status",
    "-z",
    "--format=",
    hash,
  ]);
  return parseNameStatus(stdout);
}
