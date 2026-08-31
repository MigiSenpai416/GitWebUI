import { runGit } from "./gitRunner.js";

export interface BlameCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  committerTime: number;
  summary: string;
  boundary: boolean;
  uncommitted: boolean;
}

export interface BlameLine {
  lineNumber: number;
  originalLine: number;
  commitHash: string;
  originalPath: string;
  previousHash: string | null;
  previousPath: string | null;
  text: string;
}

export interface BlameResult {
  path: string;
  snapshot: "working-tree" | "head" | "revision";
  revision: string | null;
  lines: BlameLine[];
  commits: BlameCommit[];
}

interface EntryMetadata {
  author?: string;
  "author-mail"?: string;
  "author-time"?: string;
  committer?: string;
  "committer-mail"?: string;
  "committer-time"?: string;
  summary?: string;
  filename?: string;
  previous?: string;
  boundary?: string;
}

const HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/i;

/** Parse `git blame --line-porcelain` into compact, UI-oriented records. */
export function parseBlamePorcelain(
  stdout: string,
  path: string,
  snapshot: BlameResult["snapshot"] = "working-tree",
  revision: string | null = null,
): BlameResult {
  const rows = stdout.split("\n");
  const commits = new Map<string, BlameCommit>();
  const lines: BlameLine[] = [];

  for (let index = 0; index < rows.length;) {
    const header = HEADER.exec(rows[index]);
    if (!header) {
      index += 1;
      continue;
    }
    const [, hash, originalLineRaw, lineNumberRaw] = header;
    index += 1;
    const metadata: EntryMetadata = {};
    while (index < rows.length && !rows[index].startsWith("\t")) {
      const row = rows[index++];
      const separator = row.indexOf(" ");
      const key = (separator < 0 ? row : row.slice(0, separator)) as keyof EntryMetadata;
      metadata[key] = separator < 0 ? "" : row.slice(separator + 1);
    }
    if (index >= rows.length) break;
    const text = rows[index++].slice(1);
    const uncommitted = /^0+$/.test(hash);
    const previous = parsePrevious(metadata.previous);
    const originalPath = decodeGitPath(metadata.filename ?? path);

    if (!commits.has(hash)) {
      commits.set(hash, {
        hash,
        shortHash: uncommitted ? "Working tree" : hash.slice(0, 8),
        author: uncommitted ? "Working tree" : metadata.author || "Unknown author",
        email: uncommitted ? "" : stripEmail(metadata["author-mail"]),
        authorTime: parseTime(metadata["author-time"]),
        committer: uncommitted ? "" : metadata.committer || "",
        committerEmail: uncommitted ? "" : stripEmail(metadata["committer-mail"]),
        committerTime: parseTime(metadata["committer-time"]),
        summary: uncommitted ? "Uncommitted change" : metadata.summary || "No commit message",
        boundary: metadata.boundary !== undefined,
        uncommitted,
      });
    }
    lines.push({
      lineNumber: Number(lineNumberRaw),
      originalLine: Number(originalLineRaw),
      commitHash: hash,
      originalPath,
      previousHash: previous?.hash ?? null,
      previousPath: previous?.path ?? null,
      text,
    });
  }

  return { path, snapshot, revision, lines, commits: [...commits.values()] };
}

/** Blame the working-tree version so local edits are explicitly identified. */
export async function getBlame(root: string, value: string, revision?: string): Promise<BlameResult> {
  const path = validatePath(value);
  if (revision) {
    if (!/^[0-9a-fA-F]{40,64}$/.test(revision)) {
      throw httpError(400, "A valid commit ID is required");
    }
    const stdout = (await runGit(root, blameArgs(path, revision))).stdout;
    if (stdout.includes("\0")) throw httpError(422, "Git blame is unavailable for binary files");
    const result = parseBlamePorcelain(stdout, path, "revision", revision);
    if (stdout && result.lines.length === 0) {
      throw httpError(422, "Git returned blame data that GitWebUI could not understand");
    }
    return result;
  }
  let snapshot: BlameResult["snapshot"] = "working-tree";
  let stdout: string;
  try {
    stdout = (await runGit(root, blameArgs(path))).stdout;
  } catch {
    // A tracked file can be deleted or renamed in the working tree while it
    // still appears in the File Manager's HEAD tree. Its last committed image
    // remains useful and is labelled explicitly in the UI.
    snapshot = "head";
    stdout = (await runGit(root, blameArgs(path, "HEAD"))).stdout;
  }
  if (stdout.includes("\0")) {
    throw httpError(422, "Git blame is unavailable for binary files");
  }
  const result = parseBlamePorcelain(stdout, path, snapshot);
  if (stdout && result.lines.length === 0) {
    throw httpError(422, "Git returned blame data that GitWebUI could not understand");
  }
  return result;
}

function blameArgs(path: string, revision?: string): string[] {
  return [
    "-c",
    "core.quotePath=false",
    "blame",
    "--line-porcelain",
    "-M",
    "-C",
    ...(revision ? [revision] : []),
    "--",
    path,
  ];
}

function validatePath(value: string): string {
  if (!value || value.includes("\0")) throw httpError(400, "A file path is required");
  return value;
}

function parsePrevious(value: string | undefined): { hash: string; path: string } | null {
  if (!value) return null;
  const match = /^([0-9a-f]{40,64}) (.+)$/i.exec(value);
  return match ? { hash: match[1], path: decodeGitPath(match[2]) } : null;
}

function stripEmail(value: string | undefined): string {
  if (!value) return "";
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

function parseTime(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Decode Git's double-quoted, C-style path representation. */
function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const chunks: Buffer[] = [];
  for (let index = 0; index < body.length;) {
    if (body[index] !== "\\") {
      const start = index;
      while (index < body.length && body[index] !== "\\") index += 1;
      chunks.push(Buffer.from(body.slice(start, index), "utf8"));
      continue;
    }
    index += 1;
    const escape = body[index++] ?? "";
    const escaped: Record<string, number> = {
      a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13,
      '"': 34, "\\": 92,
    };
    if (escape in escaped) {
      chunks.push(Buffer.from([escaped[escape]]));
      continue;
    }
    if (/[0-7]/.test(escape)) {
      let octal = escape;
      while (octal.length < 3 && /[0-7]/.test(body[index] ?? "")) octal += body[index++];
      chunks.push(Buffer.from([parseInt(octal, 8)]));
      continue;
    }
    chunks.push(Buffer.from(escape, "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
