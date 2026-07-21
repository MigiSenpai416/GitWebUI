import { promises as fs } from "node:fs";
import path from "node:path";
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

/**
 * Initialize a brand-new local repository named `name` inside `parentDir` on
 * `defaultBranch` (default "main"), seed it with a `README.md` containing
 * `# <name>`, make the initial commit, and return its info. The name must be a
 * single folder segment (no separators or traversal), the parent must exist, and
 * the target must not already be a git repo. `identity` authors the first commit;
 * a safe default is used if none is available so creation never fails.
 */
export async function createLocalRepo(
  parentDir: string,
  name: string,
  defaultBranch: string,
  identity: { name: string; email: string } | null = null,
): Promise<RepoInfo> {
  const parent = (parentDir ?? "").trim();
  const repoName = (name ?? "").trim();
  const branch = (defaultBranch ?? "").trim() || "main";

  if (!parent) throw badRequest("A parent folder is required");
  if (!repoName) throw badRequest("A repository name is required");
  if (/[\\/]/.test(repoName) || repoName === "." || repoName === ".." || repoName.includes("..")) {
    throw badRequest("The repository name can't contain path separators");
  }
  if (branch.startsWith("-") || /\s/.test(branch)) {
    throw badRequest("Invalid default branch name");
  }

  let pstat;
  try {
    pstat = await fs.stat(parent);
  } catch {
    throw badRequest(`Path not found: ${parent}`);
  }
  if (!pstat.isDirectory()) throw badRequest(`Not a folder: ${parent}`);

  const full = path.join(parent, repoName);
  let alreadyRepo = false;
  try {
    await fs.stat(path.join(full, ".git"));
    alreadyRepo = true;
  } catch {
    /* no .git — good */
  }
  if (alreadyRepo) throw badRequest(`A git repository already exists at ${full}`);

  await fs.mkdir(full, { recursive: true });
  try {
    await runGit(full, ["init", "-b", branch]);
  } catch (e) {
    if (e instanceof GitError && /ENOENT|not recognized|No such file/i.test(e.message)) {
      throw badRequest("git is not installed or not on PATH");
    }
    throw e;
  }

  // Seed a README and make the initial commit (matches GitKraken's behavior).
  await fs.writeFile(path.join(full, "README.md"), `# ${repoName}\n`, "utf8");
  await runGit(full, ["add", "--", "README.md"]);
  await initialCommit(full, "Initial commit", identity);

  return openRepo(full);
}

/** Commit with the given identity; retry with a safe default if git has none. */
async function initialCommit(
  root: string,
  message: string,
  identity: { name: string; email: string } | null,
): Promise<void> {
  const args = (id: { name: string; email: string } | null): string[] => {
    const a: string[] = [];
    if (id?.name && id?.email) {
      a.push("-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`);
    }
    return [...a, "commit", "-m", message];
  };
  try {
    await runGit(root, args(identity));
  } catch (e) {
    // A missing author config is the likely failure — retry with a default so
    // repo creation succeeds regardless of the host's git setup.
    if (identity?.name && identity?.email) throw e;
    await runGit(root, args({ name: "GitWebUI", email: "gitwebui@localhost" }));
  }
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
