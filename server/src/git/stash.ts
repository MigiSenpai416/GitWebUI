import { runGit } from "./gitRunner.js";

export interface StashEntry {
  /** Numeric position, i.e. the N in stash@{N} (0 is the most recent). */
  index: number;
  ref: string;
  message: string;
}

/** Parse `git stash list --format=%gd%x09%s` (ref<TAB>subject per line). */
export function parseStashList(stdout: string): StashEntry[] {
  const out: StashEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const ref = tab === -1 ? line.trim() : line.slice(0, tab);
    const message = tab === -1 ? "" : line.slice(tab + 1);
    const m = ref.match(/stash@\{(\d+)\}/);
    out.push({ index: m ? Number(m[1]) : out.length, ref, message });
  }
  return out;
}

export async function getStashes(root: string): Promise<StashEntry[]> {
  const { stdout } = await runGit(root, ["stash", "list", "--format=%gd%x09%s"]);
  return parseStashList(stdout);
}

export interface StashPushResult {
  /** False when the working tree was clean (nothing to stash). */
  stashed: boolean;
  output: string;
}

/**
 * Save working-tree + index changes to a new stash, including untracked files.
 * A clean tree is a no-op (stashed=false) rather than an error.
 */
export async function stashPush(
  root: string,
  opts: { message?: string } = {},
): Promise<StashPushResult> {
  const args = ["stash", "push", "--include-untracked"];
  if (opts.message && opts.message.trim()) args.push("-m", opts.message.trim());
  const { stdout, stderr } = await runGit(root, args);
  const output = (stdout + stderr).trim();
  return { stashed: !/No local changes to save/i.test(output), output };
}

/**
 * Apply a stash (default: the most recent) and drop it from the stash list.
 * On merge conflicts git keeps the stash and exits non-zero, surfaced as an error.
 */
export async function stashPop(root: string, index = 0): Promise<{ output: string }> {
  const { stdout, stderr } = await runGit(root, ["stash", "pop", `stash@{${index}}`]);
  return { output: (stdout + stderr).trim() };
}

/** Apply a stash without removing it from the stash list. */
export async function stashApply(root: string, index = 0): Promise<{ output: string }> {
  const { stdout, stderr } = await runGit(root, ["stash", "apply", `stash@{${index}}`]);
  return { output: (stdout + stderr).trim() };
}

/** Delete a stash without applying it. */
export async function stashDrop(root: string, index: number): Promise<void> {
  await runGit(root, ["stash", "drop", `stash@{${index}}`]);
}
