import { runGit } from "./gitRunner.js";

/**
 * Notes ref holding the titles/descriptions the user writes for their stashes.
 *
 * A stash is an immutable commit and git has no way to rename one — `git stash
 * list` reads its labels from the stash reflog, which can only be appended to
 * or rewritten by hand. So the user's own words live in a note keyed by the
 * stash commit, which leaves the stash stack (and everyone's indexes) alone,
 * survives any number of pushes and drops, and can hold more than one line.
 */
export const STASH_NOTES_REF = "refs/notes/gitwebui-stash";

/** Field/record separators — control characters a commit subject can't hold. */
const FS = "\x1f";
const RS = "\x1e";

export interface StashEntry {
  /** Numeric position, i.e. the N in stash@{N} (0 is the most recent). */
  index: number;
  ref: string;
  /** The stash commit. Unlike the index, it doesn't shift as stashes come and go. */
  hash: string;
  /** git's own one-liner, e.g. "WIP on main: 1a2b3c4 Add feature". */
  message: string;
  /** Author date, unix seconds. */
  date: number;
  /** First line of the user's note, if they wrote one. */
  noteTitle: string;
  /** The rest of it. */
  noteBody: string;
}

const FORMAT = `%gd${FS}%H${FS}%ct${FS}%s${FS}%N${RS}`;

/** Parse the record stream produced by FORMAT. */
export function parseStashList(stdout: string): StashEntry[] {
  const out: StashEntry[] = [];
  for (const record of stdout.split(RS)) {
    // git separates entries with a newline, which lands ahead of the next record.
    const line = record.replace(/^\r?\n/, "");
    if (!line.trim()) continue;
    const [ref = "", hash = "", date = "", message = "", note = ""] = line.split(FS);
    const m = ref.match(/stash@\{(\d+)\}/);
    const { title, body } = splitNote(note);
    out.push({
      index: m ? Number(m[1]) : out.length,
      ref: ref.trim(),
      hash: hash.trim(),
      message,
      date: Number(date) || 0,
      noteTitle: title,
      noteBody: body,
    });
  }
  return out;
}

/** A note is a commit message shape: first line the title, the rest the body. */
function splitNote(note: string): { title: string; body: string } {
  const text = note.replace(/\s+$/, "");
  if (!text.trim()) return { title: "", body: "" };
  const nl = text.indexOf("\n");
  if (nl === -1) return { title: text.trim(), body: "" };
  return { title: text.slice(0, nl).trim(), body: text.slice(nl + 1).replace(/^\s*\n/, "") };
}

export async function getStashes(root: string): Promise<StashEntry[]> {
  // A missing notes ref only warns on stderr, so this stays a single call
  // whether or not the user has ever written a note.
  const { stdout } = await runGit(root, [
    "stash",
    "list",
    `--notes=${STASH_NOTES_REF}`,
    `--format=${FORMAT}`,
  ]);
  return parseStashList(stdout);
}

/** Reject anything that isn't a full object id, so it can't be read as a flag or ref. */
function requireHash(hash: string): string {
  if (!/^[0-9a-f]{40}$/i.test(hash)) {
    const err = new Error("Invalid stash id") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return hash.toLowerCase();
}

export interface StashNoteOptions {
  title: string;
  description?: string;
  /** Author/committer for the notes commit, injected without touching git config. */
  identity?: { name: string; email: string } | null;
}

/**
 * Write (or clear) the note on a stash commit. An empty title and description
 * removes the note rather than storing a blank one, so clearing the fields
 * hands the stash back its git-given label.
 */
export async function setStashNote(
  root: string,
  hash: string,
  opts: StashNoteOptions,
): Promise<void> {
  const sha = requireHash(hash);
  const title = opts.title.trim();
  const body = (opts.description ?? "").trim();

  const args: string[] = [];
  if (opts.identity?.name && opts.identity?.email) {
    args.push("-c", `user.name=${opts.identity.name}`, "-c", `user.email=${opts.identity.email}`);
  }
  args.push("notes", `--ref=${STASH_NOTES_REF}`);
  if (!title && !body) {
    args.push("remove", "--ignore-missing", sha);
  } else {
    args.push("add", "-f", "-m", title || body);
    if (title && body) args.push("-m", body);
    args.push(sha);
  }
  await runGit(root, args);
}

/** Stash commits annotated in the notes ref, as `<note blob> <annotated>` lines. */
export function parseNotesList(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const annotated = line.trim().split(/\s+/)[1];
    if (annotated) out.push(annotated.toLowerCase());
  }
  return out;
}

/**
 * Drop notes whose stash is gone. Notes are keyed by commit, so popping or
 * dropping a stash leaves its note behind — collect them the next time we're
 * already talking to git rather than making removal the caller's problem.
 */
export async function pruneStashNotes(root: string): Promise<void> {
  const [stashes, listed] = await Promise.all([
    getStashes(root),
    runGit(root, ["notes", `--ref=${STASH_NOTES_REF}`, "list"])
      .then((r) => parseNotesList(r.stdout))
      // No notes ref yet — nothing to prune.
      .catch(() => [] as string[]),
  ]);
  const live = new Set(stashes.map((s) => s.hash.toLowerCase()));
  for (const hash of listed) {
    if (live.has(hash)) continue;
    await runGit(root, ["notes", `--ref=${STASH_NOTES_REF}`, "remove", "--ignore-missing", hash]);
  }
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
