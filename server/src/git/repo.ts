import { runGit, gitOut } from "./gitRunner.js";

export interface RepoInfo {
  root: string;
  branch: string;
  head: string | null;
}

/** Validate that `path` is inside a git work tree and return normalized repo info. */
export async function openRepo(path: string): Promise<RepoInfo> {
  // Throws GitError with a clean message if not a repo.
  const inside = (await gitOut(path, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") {
    throw new Error("Path is not inside a git work tree");
  }
  const root = (await gitOut(path, ["rev-parse", "--show-toplevel"])).trim();
  return {
    root,
    branch: await currentBranch(root),
    head: await headHash(root),
  };
}

export async function currentBranch(root: string): Promise<string> {
  const name = (await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (name && name !== "HEAD") return name;
  // Detached HEAD or unborn branch: fall back to the symbolic ref name if present.
  try {
    const sym = (await gitOut(root, ["symbolic-ref", "--short", "HEAD"])).trim();
    if (sym) return sym;
  } catch {
    /* detached */
  }
  return name || "HEAD";
}

/** HEAD commit hash, or null for an unborn branch (no commits yet). */
export async function headHash(root: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}
