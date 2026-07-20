import { runGit } from "./gitRunner.js";

export interface Branch {
  name: string;
  current: boolean;
  shortHash: string;
  upstream: string | null;
}

const US = "\x1f";
const RS = "\x1e";

/** List local branches with the current one marked. */
export function parseBranches(stdout: string): Branch[] {
  const branches: Branch[] = [];
  for (const record of stdout.split(RS)) {
    const rec = record.replace(/^\n/, "").trim();
    if (!rec) continue;
    const [head, name, hash, upstream] = rec.split(US);
    if (!name) continue;
    branches.push({
      name,
      current: head.trim() === "*",
      shortHash: hash ?? "",
      upstream: upstream ? upstream : null,
    });
  }
  return branches;
}

export async function getBranches(root: string): Promise<Branch[]> {
  const format = ["%(HEAD)", "%(refname:short)", "%(objectname:short)", "%(upstream:short)"].join(US) + RS;
  const { stdout } = await runGit(root, [
    "for-each-ref",
    `--format=${format}`,
    "--sort=-committerdate",
    "refs/heads",
  ]);
  return parseBranches(stdout);
}

export interface RemoteBranch {
  /** Name without the refs/remotes/ prefix, e.g. "origin/feature/x". */
  name: string;
  /** Remote name, e.g. "origin". */
  remote: string;
  /** Branch path under the remote, e.g. "feature/x". */
  shortName: string;
  /** Full ref, e.g. "refs/remotes/origin/feature/x" — used as the log revision. */
  ref: string;
  shortHash: string;
}

/** Parse the raw for-each-ref output of remote-tracking refs (see getRemoteBranches). */
export function parseRemoteBranches(stdout: string): RemoteBranch[] {
  const out: RemoteBranch[] = [];
  for (const record of stdout.split(RS)) {
    const rec = record.replace(/^\n/, "").trim();
    if (!rec) continue;
    const [refname, hash] = rec.split(US);
    if (!refname || !refname.startsWith("refs/remotes/")) continue;
    const rest = refname.slice("refs/remotes/".length); // "origin/feature/x"
    const slash = rest.indexOf("/");
    if (slash === -1) continue;
    const remote = rest.slice(0, slash);
    const shortName = rest.slice(slash + 1);
    // Skip the symbolic "origin/HEAD -> origin/main" pointer.
    if (shortName === "HEAD" || !shortName) continue;
    out.push({ name: rest, remote, shortName, ref: refname, shortHash: hash ?? "" });
  }
  return out;
}

/** List remote-tracking branches (across all remotes). */
export async function getRemoteBranches(root: string): Promise<RemoteBranch[]> {
  const format = ["%(refname)", "%(objectname:short)"].join(US) + RS;
  const { stdout } = await runGit(root, [
    "for-each-ref",
    `--format=${format}`,
    "--sort=refname",
    "refs/remotes",
  ]);
  return parseRemoteBranches(stdout);
}

/** Switch the working tree to an existing local branch. */
export async function checkoutBranch(root: string, name: string): Promise<void> {
  await runGit(root, ["checkout", name]);
}

/**
 * Check out a specific commit as a detached HEAD — a temporary, branch-less
 * checkout of that commit's files. Switching back to a real branch discards it.
 */
export async function checkoutCommit(root: string, hash: string): Promise<void> {
  if (hash.startsWith("-")) throw Object.assign(new Error("Invalid commit"), { status: 400 });
  await runGit(root, ["checkout", "--detach", hash]);
}

/** Create a new branch at `hash` and check it out. */
export async function createBranchAt(root: string, name: string, hash: string): Promise<void> {
  await runGit(root, ["checkout", "-b", name, hash]);
}

/** Force-delete a local branch (git branch -D). Cannot delete the current one. */
export async function deleteBranch(root: string, name: string): Promise<void> {
  await runGit(root, ["branch", "-D", name]);
}
