import { parseNameStatus } from "./commitFiles.js";
import { runGit } from "./gitRunner.js";
import type { ChangeStatus } from "./status.js";

export interface FileHistoryEntry {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  dateISO: string;
  subject: string;
  status: ChangeStatus;
  path: string;
  oldPath: string | null;
  contentHash: string | null;
  contentPath: string;
}

export interface FileHistoryResult {
  path: string;
  query: string;
  entries: FileHistoryEntry[];
  hasMore: boolean;
}

const FORMAT = ["%x00%H", "%h", "%P", "%an", "%ae", "%aI", "%s"].join("%x00");

/** Parse the delimited metadata and NUL-delimited name-status from `git log`. */
export function parseFileHistoryLog(stdout: string): FileHistoryEntry[] {
  const entries: FileHistoryEntry[] = [];
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length;) {
    while (index < tokens.length && tokens[index] === "") index += 1;
    const hash = tokens[index++];
    if (!/^[0-9a-f]{40,64}$/i.test(hash ?? "") || index + 6 > tokens.length) continue;
    const shortHash = tokens[index++];
    const parentText = tokens[index++];
    const author = tokens[index++];
    const email = tokens[index++];
    const dateISO = tokens[index++];
    const subject = tokens[index++];
    const status = (tokens[index++] ?? "").replace(/^\n+/, "");
    const pathCount = /^[RC]/i.test(status) ? 2 : 1;
    const pathTokens = tokens.slice(index, index + pathCount);
    index += pathCount;
    const files = parseNameStatus([status, ...pathTokens, ""].join("\0"));
    const file = files[0];
    if (!file) continue;
    const parents = parentText.trim() ? parentText.trim().split(/\s+/) : [];
    entries.push({
      hash,
      shortHash,
      parents,
      author,
      email,
      dateISO,
      subject,
      status: file.status,
      path: file.path,
      oldPath: file.oldPath ?? null,
      contentHash: file.status === "D" ? parents[0] ?? null : hash,
      contentPath: file.path,
    });
  }
  return entries;
}

/**
 * List commits that touched one exact path, following whole-file renames.
 * An optional pickaxe query finds commits where the exact text's occurrence
 * count changed, which covers both additions and removals.
 */
export async function getFileHistory(
  root: string,
  value: string,
  skip: number,
  limit: number,
  query = "",
): Promise<FileHistoryResult> {
  const path = validatePath(value);
  if (query.length > 2_000) throw httpError(400, "Remembered text is too long to search");
  const stashTips = await runGit(root, [
    "reflog",
    "show",
    "--format=%H",
    "refs/stash",
  ]).then(({ stdout }) => stdout).catch(() => "");
  const end = skip + limit;
  const args = [
    "-c",
    "core.quotePath=false",
    "log",
    "--exclude=refs/notes/*",
    "--exclude=refs/gitwebui-history-rewrite/*",
    "--all",
    "--stdin",
    "--follow",
    "--diff-merges=first-parent",
    "--date-order",
    `--format=${FORMAT}`,
    "--name-status",
    "-z",
    `--max-count=${end + 1}`,
    ...(query ? ["-S", query] : []),
    "--",
    `:(literal)${path}`,
  ];
  const entries = parseFileHistoryLog((await runGit(root, args, {
    input: stashTips ? `${stashTips}\n` : "",
  })).stdout);
  const hasMore = entries.length > end;
  return {
    path,
    query,
    entries: entries.slice(skip, end),
    hasMore,
  };
}

function validatePath(value: string): string {
  if (!value || value.includes("\0")) throw httpError(400, "A file path is required");
  return value;
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
