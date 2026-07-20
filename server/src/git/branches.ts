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

/** Switch the working tree to an existing local branch. */
export async function checkoutBranch(root: string, name: string): Promise<void> {
  await runGit(root, ["checkout", name]);
}

/** Create a new branch at `hash` and check it out. */
export async function createBranchAt(root: string, name: string, hash: string): Promise<void> {
  await runGit(root, ["checkout", "-b", name, hash]);
}

/** Force-delete a local branch (git branch -D). Cannot delete the current one. */
export async function deleteBranch(root: string, name: string): Promise<void> {
  await runGit(root, ["branch", "-D", name]);
}
