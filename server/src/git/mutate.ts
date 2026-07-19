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

export interface CommitOptions {
  title: string;
  description?: string;
  amend?: boolean;
}

/** Create a commit from the current index. Returns the new HEAD hash. */
export async function commit(root: string, opts: CommitOptions): Promise<string> {
  const title = opts.title.trim();
  if (!title) {
    const err = new Error("Commit summary is required") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const args = ["commit", "-m", title];
  const desc = (opts.description ?? "").trim();
  if (desc) args.push("-m", desc);
  if (opts.amend) args.push("--amend");
  await runGit(root, args);
  return (await headHash(root)) ?? "";
}
