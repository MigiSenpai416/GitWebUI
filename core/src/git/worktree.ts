import { runGit } from "./gitRunner.js";

export interface Worktree {
  /** Absolute path to the worktree's directory. */
  path: string;
  /** HEAD commit hash, or null (e.g. a bare entry). */
  head: string | null;
  /** Checked-out branch name (short), or null when detached/bare. */
  branch: string | null;
  /** The primary worktree (the original repo directory). */
  isMain: boolean;
  /** Whether this worktree is the one the current request targets. */
  current: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

/** Normalize a path for comparison (uniform separators; case-fold on Windows). */
export function normPath(p: string): string {
  const t = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? t.toLowerCase() : t;
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/** Parse `git worktree list --porcelain` (blank-line separated records). */
export function parseWorktrees(stdout: string, currentRoot?: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Partial<Worktree> | null = null;
  const flush = () => {
    if (cur && cur.path) {
      out.push({
        path: cur.path,
        head: cur.head ?? null,
        branch: cur.branch ?? null,
        detached: cur.detached ?? false,
        bare: cur.bare ?? false,
        locked: cur.locked ?? false,
        isMain: false,
        current: false,
      });
    }
    cur = null;
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      cur = { path: val };
    } else if (!cur) {
      continue;
    } else if (key === "HEAD") {
      cur.head = val;
    } else if (key === "branch") {
      cur.branch = val.replace(/^refs\/heads\//, "");
    } else if (key === "detached") {
      cur.detached = true;
    } else if (key === "bare") {
      cur.bare = true;
    } else if (key === "locked") {
      cur.locked = true;
    }
  }
  flush();
  if (out.length > 0) out[0].isMain = true;
  if (currentRoot) {
    for (const w of out) if (samePath(w.path, currentRoot)) w.current = true;
  }
  return out;
}

/** List the repo's worktrees (the main one first), marking the current target. */
export async function listWorktrees(root: string): Promise<Worktree[]> {
  const { stdout } = await runGit(root, ["worktree", "list", "--porcelain"]);
  return parseWorktrees(stdout, root);
}

/**
 * Add a worktree at `path`, checking out `ref`. When `newBranch` is given, create
 * that branch there (`git worktree add -b <newBranch> <path> <ref>`).
 */
export async function addWorktree(
  root: string,
  opts: { path: string; ref: string; newBranch?: string },
): Promise<void> {
  const wtPath = (opts.path ?? "").trim();
  const ref = (opts.ref ?? "").trim();
  const nb = (opts.newBranch ?? "").trim();
  if (!wtPath) throw badRequest("A working directory is required");
  if (wtPath.startsWith("-") || ref.startsWith("-") || nb.startsWith("-")) {
    throw badRequest("Invalid worktree parameters");
  }
  const args = ["worktree", "add"];
  if (nb) args.push("-b", nb);
  args.push(wtPath);
  if (ref) args.push(ref);
  await runGit(root, args);
}

/**
 * Remove the worktree at `path` (git refuses the main/current one) and delete the
 * branch it had checked out — a worktree's branch lives only there, so it's
 * discarded with it. Detached worktrees have no branch to delete.
 */
export async function removeWorktree(root: string, wtPath: string, force = false): Promise<void> {
  const p = (wtPath ?? "").trim();
  if (!p || p.startsWith("-")) throw badRequest("Invalid worktree path");
  // Capture the associated branch before removing (skip main/current, which git
  // won't remove anyway, and detached worktrees which have no branch).
  const match = (await listWorktrees(root)).find((w) => samePath(w.path, p));
  const branch = match && !match.isMain && !match.current ? match.branch : null;

  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(p);
  await runGit(root, args);

  if (branch && !branch.startsWith("-")) {
    // Force-delete: the worktree (and its branch) is being discarded wholesale.
    await runGit(root, ["branch", "-D", branch]).catch(() => {
      /* worktree is already gone; a leftover branch is non-fatal */
    });
  }
}

/** Prune worktree entries whose directories no longer exist. */
export async function pruneWorktrees(root: string): Promise<void> {
  await runGit(root, ["worktree", "prune"]);
}
