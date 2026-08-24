import { promises as fs } from "node:fs";
import path from "node:path";
import { runGit } from "./gitRunner.js";
import { currentBranch } from "./repo.js";

/**
 * Merge-conflict state and the operations that resolve it.
 *
 * A conflict can arise from any operation that replays commits onto the working
 * tree — merge, pull (fetch + merge), rebase, cherry-pick, or revert. Git leaves
 * the repository in an "in progress" state (a *_HEAD marker file in the git dir)
 * with the conflicting files carrying `<<<<<<< / ======= / >>>>>>>` markers and
 * unmerged index entries. This module reports that state and lets the UI resolve
 * each file and finish (commit) or back out (abort).
 */

export type MergeKind = "merge" | "rebase" | "cherry-pick" | "revert";

export interface MergeState {
  /** Whether an operation is mid-flight or unmerged paths remain. */
  active: boolean;
  kind: MergeKind | null;
  /** The branch being merged into (the current branch). */
  intoBranch: string;
  /** A human label for the incoming side (branch name or short hash), if known. */
  fromLabel: string | null;
  /** Repo-relative paths that are still conflicted (unmerged). */
  conflicted: string[];
  /** Banner text describing the situation. */
  message: string;
}

export interface ConflictFileData {
  path: string;
  /** The working-tree file, containing conflict markers. */
  merged: string;
  /** Label for the "ours"/A side (current branch HEAD). */
  oursLabel: string;
  /** Label for the "theirs"/B side (incoming commit). */
  theirsLabel: string;
}

const INACTIVE: MergeState = {
  active: false,
  kind: null,
  intoBranch: "",
  fromLabel: null,
  conflicted: [],
  message: "",
};

/** Treat a conflicted path as a filename, never as a wildcard pathspec. */
function literalPathspec(relPath: string): string {
  return `:(literal)${relPath}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** Absolute path to the repo's git directory (handles worktrees / relative output). */
async function getGitDir(root: string): Promise<string> {
  const { stdout } = await runGit(root, ["rev-parse", "--git-dir"]);
  return path.resolve(root, stdout.trim());
}

async function detectKind(gitDir: string): Promise<MergeKind | null> {
  if (await pathExists(path.join(gitDir, "MERGE_HEAD"))) return "merge";
  if (
    (await pathExists(path.join(gitDir, "rebase-merge"))) ||
    (await pathExists(path.join(gitDir, "rebase-apply")))
  ) {
    return "rebase";
  }
  if (await pathExists(path.join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (await pathExists(path.join(gitDir, "REVERT_HEAD"))) return "revert";
  return null;
}

/** Repo-relative paths with unmerged index entries. */
export async function conflictedPaths(root: string): Promise<string[]> {
  const { stdout } = await runGit(root, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  return stdout.split("\0").filter((s) => s.length > 0);
}

/** Whether the working tree currently has any unmerged (conflicted) paths. */
export async function isConflicted(root: string): Promise<boolean> {
  return (await conflictedPaths(root)).length > 0;
}

async function shortHash(root: string, rev: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(root, ["rev-parse", "--short", rev]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const HEAD_FILE: Record<MergeKind, string | null> = {
  merge: "MERGE_HEAD",
  "cherry-pick": "CHERRY_PICK_HEAD",
  revert: "REVERT_HEAD",
  rebase: null,
};

async function incomingHash(root: string, gitDir: string, kind: MergeKind | null): Promise<string | null> {
  if (!kind) return null;
  if (kind === "rebase") {
    const onto =
      (await readFileSafe(path.join(gitDir, "rebase-merge", "onto"))) ??
      (await readFileSafe(path.join(gitDir, "rebase-apply", "onto")));
    const h = onto?.trim().split("\n")[0];
    return h ? (await shortHash(root, h)) ?? h.slice(0, 7) : null;
  }
  const file = HEAD_FILE[kind];
  if (!file) return null;
  const raw = (await readFileSafe(path.join(gitDir, file)))?.trim().split("\n")[0];
  return raw ? (await shortHash(root, raw)) ?? raw.slice(0, 7) : null;
}

async function incomingLabel(root: string, gitDir: string, kind: MergeKind | null): Promise<string | null> {
  if (kind === "merge") {
    const msg = await readFileSafe(path.join(gitDir, "MERGE_MSG"));
    const m = msg && /Merge (?:remote-tracking branch|branch|commit) '([^']+)'/.exec(msg);
    if (m) return m[1];
  }
  return incomingHash(root, gitDir, kind);
}

function verbFor(kind: MergeKind | null): string {
  switch (kind) {
    case "rebase":
      return "rebase";
    case "cherry-pick":
      return "cherry-pick";
    case "revert":
      return "revert";
    default:
      return "merge";
  }
}

/** Current merge/rebase/etc. conflict state, or an inactive result. */
export async function getMergeState(root: string): Promise<MergeState> {
  const gitDir = await getGitDir(root);
  const kind = await detectKind(gitDir);
  const conflicted = await conflictedPaths(root);
  if (!kind && conflicted.length === 0) return INACTIVE;

  const intoBranch = await currentBranch(root);
  const fromLabel = await incomingLabel(root, gitDir, kind);
  const verb = verbFor(kind);
  const n = conflicted.length;
  const message =
    n > 0
      ? `${n} file conflict${n === 1 ? "" : "s"} ${n === 1 ? "was" : "were"} found when attempting to ${verb} into ${intoBranch}`
      : `All conflicts resolved — commit to finish the ${verb} into ${intoBranch}.`;

  return { active: true, kind, intoBranch, fromLabel, conflicted, message };
}

/** Resolve a repo-relative path to an absolute one, rejecting escapes outside the repo. */
function resolveInRepo(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw Object.assign(new Error("Path is outside the repository"), { status: 400 });
  }
  return abs;
}

/** The three-way content for a single conflicted file. */
export async function getConflictFile(root: string, relPath: string): Promise<ConflictFileData> {
  const abs = resolveInRepo(root, relPath);
  const merged = (await readFileSafe(abs)) ?? "";
  const gitDir = await getGitDir(root);
  const kind = await detectKind(gitDir);
  const branch = await currentBranch(root);
  const headShort = (await shortHash(root, "HEAD")) ?? "HEAD";
  const theirs = await incomingHash(root, gitDir, kind);
  return {
    path: relPath,
    merged,
    oursLabel: `Commit ${headShort} on ${branch}`,
    theirsLabel: theirs ? `Commit ${theirs}` : "Incoming",
  };
}

/**
 * Write a file's resolved content back to the working tree. When `resolved` is
 * true the file is also staged (`git add`), which clears its unmerged status.
 */
export async function writeResolution(
  root: string,
  relPath: string,
  content: string,
  resolved: boolean,
): Promise<void> {
  const abs = resolveInRepo(root, relPath);
  await fs.writeFile(abs, content, "utf8");
  if (resolved) await runGit(root, ["add", "--", literalPathspec(relPath)]);
}

/** Mark paths resolved by staging their current working-tree content. */
export async function markResolved(root: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(root, ["add", "--", ...paths.map(literalPathspec)]);
}

/** Abort the in-progress operation, restoring the pre-operation state. */
export async function abortMerge(root: string): Promise<void> {
  const kind = await detectKind(await getGitDir(root));
  const cmd =
    kind === "rebase"
      ? ["rebase", "--abort"]
      : kind === "cherry-pick"
        ? ["cherry-pick", "--abort"]
        : kind === "revert"
          ? ["revert", "--abort"]
          : ["merge", "--abort"];
  await runGit(root, cmd);
}

/**
 * Merge `name` into the current branch. A conflict is not an error: git leaves
 * the merge in progress, which the caller surfaces via `getMergeState`.
 */
export async function mergeBranch(root: string, name: string): Promise<void> {
  if (name.startsWith("-")) {
    throw Object.assign(new Error("Invalid branch name"), { status: 400 });
  }
  try {
    await runGit(root, ["merge", "--no-edit", name]);
  } catch (e) {
    if (!(await isConflicted(root))) throw e;
  }
}

/**
 * Apply the changes introduced by `hash` onto the current branch.
 * - `noCommit: false` commits the cherry-pick immediately (git's default).
 * - `noCommit: true` applies it to the index/working tree without committing,
 *   leaving the changes to review.
 * A resulting conflict is not an error; it's left in progress for resolution.
 */
export async function cherryPick(root: string, hash: string, noCommit: boolean): Promise<void> {
  if (hash.startsWith("-")) {
    throw Object.assign(new Error("Invalid commit"), { status: 400 });
  }
  const args = ["cherry-pick"];
  if (noCommit) args.push("--no-commit");
  args.push(hash);
  try {
    await runGit(root, args);
  } catch (e) {
    if (!(await isConflicted(root))) throw e;
  }
}
