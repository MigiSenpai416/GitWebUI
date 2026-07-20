import path from "node:path";
import { promises as fs } from "node:fs";
import { runGit } from "./gitRunner.js";
import { headHash } from "./repo.js";

/** Stage one or more paths (handles new, modified, and deleted files). */
export async function stagePaths(root: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(root, ["add", "-A", "--", ...paths]);
}

/** Stage every change in the work tree. */
export async function stageAll(root: string): Promise<void> {
  await runGit(root, ["add", "-A"]);
}

/** Unstage one or more paths, restoring the index entry from HEAD. */
export async function unstagePaths(root: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const head = await headHash(root);
  if (head) {
    await runGit(root, ["restore", "--staged", "--", ...paths]);
  } else {
    // Unborn branch: no HEAD to restore from — remove entries from the index.
    await runGit(root, ["rm", "--cached", "-r", "--", ...paths]);
  }
}

/**
 * Discard ALL staged and unstaged changes: reset tracked files to HEAD and
 * delete untracked files/directories. Destructive and irreversible — the UI
 * confirms before calling this.
 */
export async function discardAll(root: string): Promise<void> {
  const head = await headHash(root);
  if (head) {
    await runGit(root, ["reset", "--hard", "HEAD"]);
  } else {
    // Unborn branch: nothing tracked to reset; just clear the index.
    await runGit(root, ["rm", "-r", "--cached", "--ignore-unmatch", "."]).catch(() => {});
  }
  await runGit(root, ["clean", "-fd"]);
}

/**
 * Discard changes for specific paths only (a single file or every file under a
 * folder): unstage them, restore tracked files to HEAD, and remove any
 * untracked files. Destructive and irreversible — the UI confirms first.
 */
export async function discardPaths(root: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const head = await headHash(root);
  if (head) {
    // Unstage first so a newly-added file becomes untracked, then restore
    // tracked files to their HEAD content.
    await runGit(root, ["reset", "-q", "HEAD", "--", ...paths]).catch(() => {});
    await runGit(root, ["checkout", "HEAD", "--", ...paths]).catch(() => {});
  } else {
    // Unborn branch: no HEAD to restore from — just drop index entries.
    await runGit(root, ["rm", "-q", "--cached", "-r", "--ignore-unmatch", "--", ...paths]).catch(
      () => {},
    );
  }
  // Remove untracked files/dirs among the given paths (including files that
  // were just unstaged from an add).
  await runGit(root, ["clean", "-fd", "--", ...paths]);
}

/** Resolve a repo-relative path to an absolute one, rejecting escapes outside the repo. */
function resolveInRepo(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    const err = new Error("Path is outside the repository") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return abs;
}

/** Delete a file from the working tree (leaves the removal as a pending change). */
export async function deleteFile(root: string, relPath: string): Promise<void> {
  const abs = resolveInRepo(root, relPath);
  await fs.rm(abs, { force: true });
}

export type ResetMode = "hard" | "soft" | "mixed";

/**
 * Move the current branch to `hash`.
 * - hard:  discard all working-tree and index changes
 * - soft:  keep working tree and index (changes become staged)
 * - mixed: keep working tree, reset the index (changes become unstaged)
 */
export async function resetTo(root: string, hash: string, mode: ResetMode): Promise<void> {
  await runGit(root, ["reset", `--${mode}`, hash]);
}

/** Create a new commit that undoes `hash`. */
export async function revertCommit(root: string, hash: string): Promise<void> {
  await runGit(root, ["revert", "--no-edit", hash]);
}

export interface CommitOptions {
  title: string;
  description?: string;
  amend?: boolean;
  /** Author/committer identity, injected without touching git config. */
  identity?: { name: string; email: string } | null;
}

/** Create a commit from the current index. Returns the new HEAD hash. */
export async function commit(root: string, opts: CommitOptions): Promise<string> {
  const title = opts.title.trim();
  if (!title) {
    const err = new Error("Commit summary is required") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  // `-c` overrides must precede the subcommand; passed as argv so values with
  // spaces/metacharacters are safe.
  const args: string[] = [];
  if (opts.identity?.name && opts.identity?.email) {
    args.push("-c", `user.name=${opts.identity.name}`, "-c", `user.email=${opts.identity.email}`);
  }
  args.push("commit", "-m", title);
  const desc = (opts.description ?? "").trim();
  if (desc) args.push("-m", desc);
  if (opts.amend) args.push("--amend");
  await runGit(root, args);
  return (await headHash(root)) ?? "";
}
