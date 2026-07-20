import { promises as fs } from "node:fs";
import { runGit, gitOut, GitError } from "./gitRunner.js";

export interface RepoInfo {
  root: string;
  branch: string;
  head: string | null;
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Validate that `input` is an existing folder inside a git work tree and return
 * normalized repo info. Every failure mode (empty/garbage string, missing path,
 * a file, a non-repo folder, git not installed) yields a clean 400 message
 * instead of a raw `spawn git ENOENT`, so a bad path can never destabilize the
 * server.
 */
export async function openRepo(input: string): Promise<RepoInfo> {
  const path = (input ?? "").trim();
  if (!path) throw badRequest("A repository path is required");

  // Check the path on disk first so we never spawn git with an invalid cwd.
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    throw badRequest(`Path not found: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw badRequest(`Not a folder: ${path}`);
  }

  let inside: string;
  try {
    inside = (await gitOut(path, ["rev-parse", "--is-inside-work-tree"])).trim();
  } catch (e) {
    // Distinguish "git missing" from "folder isn't a repo" for a clear message.
    if (e instanceof GitError && /ENOENT|not recognized|No such file/i.test(e.message)) {
      throw badRequest("git is not installed or not on PATH");
    }
    throw badRequest(`Not a git repository: ${path}`);
  }
  if (inside !== "true") {
    throw badRequest(`Not a git repository: ${path}`);
  }

  const root = (await gitOut(path, ["rev-parse", "--show-toplevel"])).trim();
  return {
    root,
    branch: await currentBranch(root),
    head: await headHash(root),
  };
}

export async function currentBranch(root: string): Promise<string> {
  // On an unborn branch (a fresh repo with no commits) `rev-parse --abbrev-ref
  // HEAD` errors, so tolerate that and fall back to the symbolic ref.
  let name = "";
  try {
    name = (await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    /* unborn branch */
  }
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
