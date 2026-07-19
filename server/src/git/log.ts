import { runGit } from "./gitRunner.js";

export interface CommitRef {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
  isHead?: boolean;
}

export interface Commit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  dateISO: string;
  subject: string;
  body: string;
  refs: CommitRef[];
}

// Field separator (unit sep) between fields; record separator terminates each commit.
const US = "\x1f";
const RS = "\x1e";
const FORMAT = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%D", "%s", "%b"].join(US) + RS;

/**
 * Parse a commit's `%D` decoration string. The log is requested with
 * `--decorate=full`, so refs arrive as full paths (refs/heads/…, refs/remotes/…,
 * refs/tags/…), which disambiguates a local branch like "feature/x" from a
 * remote-tracking ref. Short forms are still handled as a fallback.
 */
export function parseRefs(decoration: string): CommitRef[] {
  const refs: CommitRef[] = [];
  const trimmed = decoration.trim();
  if (!trimmed) return refs;
  for (const raw of trimmed.split(",")) {
    let token = raw.trim();
    if (!token) continue;
    let isHead = false;
    if (token.startsWith("HEAD -> ")) {
      isHead = true;
      token = token.slice("HEAD -> ".length).trim();
    } else if (token === "HEAD") {
      refs.push({ name: "HEAD", kind: "head", isHead: true });
      continue;
    }

    let isTag = false;
    if (token.startsWith("tag: ")) {
      isTag = true;
      token = token.slice("tag: ".length).trim();
    }

    if (token.startsWith("refs/heads/")) {
      refs.push({ name: token.slice("refs/heads/".length), kind: "branch", isHead: isHead || undefined });
    } else if (token.startsWith("refs/remotes/")) {
      refs.push({ name: token.slice("refs/remotes/".length), kind: "remote" });
    } else if (token.startsWith("refs/tags/")) {
      refs.push({ name: token.slice("refs/tags/".length), kind: "tag" });
    } else if (isTag) {
      refs.push({ name: token, kind: "tag" });
    } else {
      // Short-form fallback (no --decorate=full): "/" implies a remote-tracking ref.
      const kind: CommitRef["kind"] = token.includes("/") ? "remote" : "branch";
      refs.push({ name: token, kind, isHead: isHead || undefined });
    }
  }
  return refs;
}

/** Parse the raw separator-delimited output of `git log` (see FORMAT). */
export function parseLog(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of stdout.split(RS)) {
    const rec = record.replace(/^\n/, "");
    if (!rec.trim()) continue;
    const fields = rec.split(US);
    if (fields.length < 9) continue;
    const [hash, shortHash, parents, author, email, dateISO, decoration, subject, body] = fields;
    commits.push({
      hash,
      shortHash,
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      author,
      email,
      dateISO,
      subject,
      body: body.replace(/\n+$/, ""),
      refs: parseRefs(decoration),
    });
  }
  return commits;
}

export async function getLog(root: string, skip: number, limit: number): Promise<Commit[]> {
  const { stdout } = await runGit(root, [
    "log",
    "--decorate=full",
    `--pretty=format:${FORMAT}`,
    `--skip=${skip}`,
    `--max-count=${limit}`,
    "HEAD",
  ]);
  return parseLog(stdout);
}
