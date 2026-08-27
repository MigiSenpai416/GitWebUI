import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { configPath, ensureConfigDir } from "../config.js";
import { getStatus } from "./status.js";
import { GitError, runGit } from "./gitRunner.js";
import { listWorktrees } from "./worktree.js";
import { STASH_NOTES_REF } from "./stash.js";
import { runningCommandCount } from "../terminal.js";

export type HeadEntryKind = "file" | "symlink" | "submodule";

export interface HeadFileEntry {
  path: string;
  mode: string;
  kind: HeadEntryKind;
  size: number | null;
}

export interface HeadFileTree {
  head: string | null;
  entries: HeadFileEntry[];
}

export interface HistoryDeleteInput {
  path: string;
  expectedHead: string;
  confirmation: string;
}

export interface HistoryDeleteResult {
  path: string;
  head: string;
  backupPath: string;
  worktreeBackupPath: string;
  indexBackupPath: string;
  rewrittenRefs: number;
  warnings: string[];
}

const activeRewrites = new Set<string>();
const activeMutations = new Map<string, number>();

const FILTER_REPO_INSTALL_ERROR =
  "Deleting from Git history requires git-filter-repo, but GitWebUI could not run it. " +
  "Install it on the GitWebUI host (Windows: pipx install git-filter-repo or scoop install git-filter-repo; " +
  "macOS: brew install git-filter-repo; Linux: use your package manager or pipx), " +
  "restart GitWebUI, and verify with git filter-repo --version. " +
  "It requires Git 2.36+ and Python 3.6+. Installation guide: https://github.com/newren/git-filter-repo/blob/main/INSTALL.md";

interface IndexTransition {
  indexPath: string;
  backupPath: string;
  before: Buffer;
  after: Buffer;
}

/** Used by the API mutation gate while the ref graph is being replaced. */
export function isHistoryRewriteActive(root: string): boolean {
  return activeRewrites.has(root);
}

/** Reserve a repository for an ordinary API mutation until its response ends. */
export function beginRepoMutation(root: string): () => void {
  activeMutations.set(root, (activeMutations.get(root) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeMutations.get(root) ?? 1) - 1;
    if (remaining > 0) activeMutations.set(root, remaining);
    else activeMutations.delete(root);
  };
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** List every file-like entry in the tree at the currently checked-out HEAD. */
export async function getHeadFileTree(root: string): Promise<HeadFileTree> {
  const head = await verifiedHead(root);
  if (!head) return { head: null, entries: [] };

  const { stdout } = await runGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "-l",
    "--full-tree",
    head,
  ]);
  return { head, entries: parseLsTree(stdout) };
}

/**
 * Remove one exact HEAD path (or every entry beneath it) from all reachable
 * refs. This is deliberately narrower than an arbitrary filter command: the
 * path is verified against HEAD, passed through an environment variable, and
 * used as a literal pathspec so punctuation can never become shell/pathspec
 * syntax.
 *
 * A bundle is made before refs move. The rewrite is allowed only in a clean,
 * non-shallow repository with one worktree, because resetting multiple indexes
 * after every checked-out branch changes cannot be done without risking work.
 */
export async function deletePathFromHistory(
  root: string,
  input: HistoryDeleteInput,
): Promise<HistoryDeleteResult> {
  const target = validateRepoPath(input.path);
  if (input.confirmation !== target) {
    throw httpError(400, "Confirmation must exactly match the repository path");
  }

  if (activeRewrites.has(root)) {
    throw httpError(409, "A history rewrite is already running for this repository");
  }
  if ((activeMutations.get(root) ?? 0) > 0) {
    throw httpError(409, "Wait for other repository operations to finish before rewriting history");
  }
  activeRewrites.add(root);

  let backupPath = "";
  let refsBefore: RefState[] = [];
  let publishedRefs: RefState[] | null = null;
  let stashRecovery: StashRecovery[] = [];
  let internalPrefix = "";
  let mirrorDir = "";
  let quarantinePath = "";
  let fetchHeadBefore: string | null = null;
  let fetchHeadQuarantine = "";
  let origHeadBefore: string | null = null;
  let origHeadQuarantine = "";
  let reflogsBefore = "";
  let cleanupIrreversible = false;
  let indexTransition: IndexTransition | null = null;
  try {
    await requireFilterRepo(root);
    const oldHead = await preflight(root, target, input.expectedHead);
    fetchHeadBefore = await readPseudoRefFile(root, "FETCH_HEAD");
    origHeadBefore = await readPseudoRefFile(root, "ORIG_HEAD");
    reflogsBefore = await publicReflogSnapshot(root);
    refsBefore = await refSnapshot(root);
    internalPrefix = `refs/gitwebui-history-rewrite/${process.pid}-${Date.now()}`;
    stashRecovery = await prepareStashRecovery(root, internalPrefix);
    backupPath = await createRecoveryBundle(root, oldHead, internalPrefix);
    const sourceRefs = await refSnapshot(root);
    if (!sameRefSnapshot(refsBefore, publicRefs(sourceRefs, internalPrefix))) {
      throw httpError(409, "Repository refs changed while recovery data was prepared; nothing was rewritten");
    }
    await requirePseudoRefUnchanged(root, "FETCH_HEAD", fetchHeadBefore);
    await requirePseudoRefUnchanged(root, "ORIG_HEAD", origHeadBefore);
    await requireReflogsUnchanged(root, reflogsBefore);

    const mirrorParent = await fs.mkdtemp(path.join(os.tmpdir(), "gitwebui-history-mirror-"));
    mirrorDir = path.join(mirrorParent, "repository.git");
    await runGit(root, ["clone", "--mirror", "--no-hardlinks", root, mirrorDir]);

    // The disposable mirror and outer ref transaction provide the isolation
    // normally lost with --partial. Partial mode is intentional here: it keeps
    // remote-tracking ref names stable and leaves cleanup to the guarded live
    // repository workflow below. Preserve empty commits to match the existing
    // File Manager rewrite semantics. Stash refs fail filter-repo's fresh-clone
    // heuristic, so --force is safe and necessary only in this temporary clone.
    await runGit(mirrorDir, [
      "filter-repo",
      "--force",
      "--partial",
      "--invert-paths",
      `--path=${target}`,
      "--prune-empty=never",
      "--prune-degenerate=never",
      "--preserve-commit-hashes",
      "--preserve-commit-encoding",
    ]);
    await migrateStashNotes(mirrorDir, stashRecovery);

    // Validate in the isolated mirror before a single ref in the live repo
    // moves, then import its objects and atomically exchange all ref tips.
    await verifyPathAbsent(mirrorDir, target);
    await runGit(mirrorDir, ["fsck", "--full", "--no-reflogs"]);
    publishedRefs = await importAndUpdateRefs(
      root,
      mirrorDir,
      sourceRefs,
      internalPrefix,
      reflogsBefore,
    );
    if (!sameRefSnapshot(publishedRefs, await refSnapshot(root))) {
      throw httpError(409, "Repository refs changed during the history update; recovery was stopped");
    }
    await verifyPathAbsent(root, target);
    await requireUnchangedIndexAndWorktree(root, oldHead);

    const newHead = await verifiedHead(root);
    if (!newHead) throw new Error("History rewrite left the current branch without a HEAD");
    quarantinePath = await quarantineWorkingTreePath(root, target);
    // Rewriting one path leaves every other entry in the tip tree unchanged.
    // Update only the index; the selected worktree path was atomically moved
    // to a recovery location, so concurrent edits elsewhere are never erased.
    indexTransition = await removeTargetFromIndexAtomically(root, target, quarantinePath);
    await rebuildStashReflog(root, stashRecovery);

    // Only now discard rollback refs. Reflogs other than refs/stash are expired
    // so old commits do not remain reachable inside the repository; the stash
    // reflog was explicitly rebuilt with sanitized commits above.
    fetchHeadQuarantine = await quarantinePseudoRefFile(root, "FETCH_HEAD", fetchHeadBefore);
    origHeadQuarantine = await quarantinePseudoRefFile(root, "ORIG_HEAD", origHeadBefore);
    // Reflog expiration cannot be faithfully rolled back. Failures from here
    // are reported as an incomplete cleanup, never as a successful rollback.
    cleanupIrreversible = true;
    await expireRecoveryReflogs(root);
    await verifyRecoveryReflogsClean(root, target);
    await requirePseudoRefAbsent(root, "FETCH_HEAD");
    await requirePseudoRefAbsent(root, "ORIG_HEAD");
    await deleteRefs(root, await refNames(root, internalPrefix));
    await deletePseudoRefQuarantine(fetchHeadQuarantine);
    await deletePseudoRefQuarantine(origHeadQuarantine);

    return {
      path: target,
      head: newHead,
      backupPath,
      worktreeBackupPath: quarantinePath,
      indexBackupPath: indexTransition.backupPath,
      rewrittenRefs: countChangedRefs(refsBefore, await refSnapshot(root)),
      warnings: [
        `The removed working-tree content and pre-rewrite index were preserved at ${path.dirname(quarantinePath)} so racing edits cannot be lost.`,
        "Unreachable pre-rewrite Git objects may remain until normal pruning; use a verified fresh clone and remove the old repository plus recovery artifacts for a sensitive-data purge.",
        "Non-stash reflogs were cleared; their prior names, messages, timestamps, and ordering are available only indirectly through the recovery bundle's commits.",
      ],
    };
  } catch (error) {
    if (cleanupIrreversible) {
      throw httpError(
        500,
        `History refs were rewritten, but recovery-route cleanup did not complete. Do not retry blindly. Recovery bundle: ${backupPath}.${quarantinePath ? ` Working-tree copy: ${quarantinePath}.` : ""} ${errorMessage(error)}`,
      );
    }
    if (publishedRefs) {
      const restored = await restoreRefSnapshot(root, refsBefore, publishedRefs, internalPrefix);
      if (restored) {
        const indexRestored = indexTransition
          ? await restoreIndexTransition(indexTransition)
          : true;
        const worktreeRestored = await restoreQuarantinedPath(root, target, quarantinePath);
        await restorePseudoRefQuarantine(root, "FETCH_HEAD", fetchHeadQuarantine);
        await restorePseudoRefQuarantine(root, "ORIG_HEAD", origHeadQuarantine);
        await rebuildOriginalStashReflog(root, stashRecovery).catch(() => undefined);
        throw httpError(
          500,
          `History rewrite failed and the original refs were restored.${indexTransition ? ` Pre-rewrite index backup: ${indexTransition.backupPath}.` : ""}${indexRestored ? "" : " The live index changed again and was not overwritten."}${worktreeRestored ? "" : ` The working-tree copy remains at ${quarantinePath}.`} Recovery bundle: ${backupPath}. ${errorMessage(error)}`,
        );
      }
      throw httpError(
        500,
        `History rewrite failed, but refs changed again and were not overwritten during rollback. Recovery bundle: ${backupPath}.${quarantinePath ? ` Working-tree copy: ${quarantinePath}.` : ""} ${errorMessage(error)}`,
      );
    } else if (internalPrefix) {
      await deleteRefs(root, await refNames(root, internalPrefix).catch(() => [])).catch(
        () => undefined,
      );
    }
    throw error;
  } finally {
    if (mirrorDir) {
      await fs.rm(path.dirname(mirrorDir), { recursive: true, force: true }).catch(() => undefined);
    }
    activeRewrites.delete(root);
  }
}

async function requireFilterRepo(root: string): Promise<void> {
  try {
    await runGit(root, ["filter-repo", "--version"]);
  } catch (error) {
    if (error instanceof GitError && /\bENOENT\b|No such file/i.test(error.message)) {
      throw httpError(
        422,
        `GitWebUI could not run the configured Git executable. Reinstall or locate Git, then retry. (${errorMessage(error)})`,
      );
    }
    throw httpError(422, `${FILTER_REPO_INSTALL_ERROR} (${errorMessage(error)})`);
  }
}

export function parseLsTree(stdout: string): HeadFileEntry[] {
  const entries: HeadFileEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const [mode, type, , rawSize] = meta;
    if (!mode || !type) continue;
    entries.push({
      path: record.slice(tab + 1),
      mode,
      kind: mode === "120000" ? "symlink" : type === "commit" ? "submodule" : "file",
      size: rawSize && /^\d+$/.test(rawSize) ? Number(rawSize) : null,
    });
  }
  return entries;
}

async function preflight(root: string, target: string, expectedHead: string): Promise<string> {
  if (!/^[0-9a-fA-F]{40,64}$/.test(expectedHead ?? "")) {
    throw httpError(400, "A valid expected HEAD is required");
  }
  const head = await verifiedHead(root);
  if (!head) throw httpError(409, "The repository has no commits to rewrite");
  if (head.toLowerCase() !== expectedHead.toLowerCase()) {
    throw httpError(409, "HEAD changed since the File Manager loaded. Refresh it and try again");
  }
  const objectFormat = await gitText(root, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1") {
    throw httpError(
      422,
      `git-filter-repo does not support this repository's ${objectFormat} object format; only SHA-1 repositories can currently be rewritten. Nothing was rewritten`,
    );
  }

  try {
    await runGit(root, ["symbolic-ref", "-q", "HEAD"]);
  } catch {
    throw httpError(409, "Check out a branch before rewriting history; detached HEAD is not supported");
  }

  await requirePathAtHead(root, head, target);
  await rejectFilesystemAliasedSelection(root, head, target);

  if (runningCommandCount() > 0) {
    throw httpError(409, "Wait for running terminal commands to finish before rewriting history");
  }

  // `--really-refresh` disregards assume-unchanged while checking the index's
  // stat data. Reject assume-unchanged and sparse checkouts explicitly too: a
  // hard reset cannot safely prove it will preserve hidden local edits there.
  const assumeUnchanged = await assumedUnchangedPaths(root);
  if (assumeUnchanged.length) {
    throw httpError(409, "Clear assume-unchanged file flags before rewriting history");
  }
  const skipWorktree = await skipWorktreePaths(root);
  if (skipWorktree.length) {
    throw httpError(409, "Clear skip-worktree file flags before rewriting history");
  }
  if ((await gitText(root, ["config", "--bool", "core.sparseCheckout"]).catch(() => "false")) === "true") {
    throw httpError(409, "Disable sparse checkout before rewriting history");
  }
  try {
    await runGit(root, ["update-index", "--really-refresh"]);
  } catch {
    throw httpError(409, "History rewriting requires a clean working tree");
  }
  const status = await getStatus(root);
  if (status.staged.length || status.unstaged.length) {
    throw httpError(
      409,
      "History rewriting requires a clean working tree, including no staged or untracked files",
    );
  }

  if ((await gitText(root, ["rev-parse", "--is-shallow-repository"])) === "true") {
    throw httpError(409, "History rewriting is unavailable in a shallow repository; unshallow it first");
  }

  const worktrees = await listWorktrees(root);
  if (worktrees.length !== 1) {
    throw httpError(
      409,
      "Remove linked worktrees before rewriting history so their checked-out branches cannot be corrupted",
    );
  }

  if (await hasInProgressOperation(root)) {
    throw httpError(409, "Finish or abort the in-progress Git operation before rewriting history");
  }

  if ((await refNames(root, "refs/replace")).length) {
    throw httpError(409, "Remove Git replacement refs before rewriting history");
  }
  if ((await originalRefs(root)).length) {
    throw httpError(
      409,
      "This repository already has refs/original backup refs from an earlier rewrite; resolve them first",
    );
  }
  if ((await refNames(root, "refs/gitwebui-history-rewrite")).length) {
    throw httpError(
      409,
      "An interrupted GitWebUI history rewrite left recovery refs; resolve them before retrying",
    );
  }

  await rejectNonCommitRefs(root);

  return head;
}

function validateRepoPath(value: string): string {
  const target = String(value ?? "");
  if (!target || target === "." || target === "..") {
    throw httpError(400, "A repository-relative file or directory path is required");
  }
  if (
    target.includes("\0") ||
    target.startsWith("/") ||
    target.endsWith("/") ||
    (process.platform === "win32" && target.includes("\\"))
  ) {
    throw httpError(400, "Invalid repository path");
  }
  const parts = target.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw httpError(400, "Invalid repository path");
  }
  return target;
}

async function verifiedHead(root: string): Promise<string | null> {
  try {
    return await gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    return null;
  }
}

async function requirePathAtHead(root: string, head: string, target: string): Promise<void> {
  const { stdout } = await runGit(root, [
    "ls-tree",
    "-z",
    head,
    "--",
    `:(literal)${target}`,
  ]);
  const matches = stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => record.slice(record.indexOf("\t") + 1));
  if (!matches.includes(target)) {
    throw httpError(409, `The path no longer exists at HEAD: ${target}`);
  }
}

async function rejectFilesystemAliasedSelection(
  root: string,
  head: string,
  target: string,
): Promise<void> {
  if (process.platform !== "win32") return;
  const { stdout } = await runGit(root, ["ls-tree", "-r", "-z", "--name-only", head]);
  const paths = stdout.split("\0").filter(Boolean);
  const selected = paths.filter((item) => item === target || item.startsWith(`${target}/`));
  const selectedPaths = new Set(selected);
  const selectedPhysicalPaths = new Set(selected.map(windowsFilesystemPath));
  const retained = paths.filter((item) => !selectedPaths.has(item));
  const foldedTarget = windowsFilesystemPath(target);
  const aliases = retained.some((item) => {
    const folded = windowsFilesystemPath(item);
    return (
      folded === foldedTarget ||
      folded.startsWith(`${foldedTarget}/`) ||
      selectedPhysicalPaths.has(folded)
    );
  });
  if (aliases) {
    throw httpError(
      409,
      "The selected path aliases a retained HEAD path on this case-insensitive filesystem; rewrite it from a case-sensitive checkout",
    );
  }
}

function windowsFilesystemPath(value: string): string {
  return value
    .split("/")
    .map((part) => part.normalize("NFC").toLowerCase().replace(/[ .]+$/g, ""))
    .join("/");
}

async function hasInProgressOperation(root: string): Promise<boolean> {
  const names = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "BISECT_START",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ];
  for (const name of names) {
    const gitPath = await gitText(root, ["rev-parse", "--git-path", name]);
    try {
      await fs.access(path.isAbsolute(gitPath) ? gitPath : path.join(root, gitPath));
      return true;
    } catch {
      /* absent */
    }
  }
  return false;
}

async function rejectNonCommitRefs(root: string): Promise<void> {
  for (const ref of await refNames(root, "refs")) {
    try {
      await runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
    } catch {
      throw httpError(
        409,
        `History rewriting is unavailable while ${ref} directly names a tree or blob; remove or convert that ref first`,
      );
    }
  }
}

interface StashRecovery {
  ref: string;
  originalOid: string;
  message: string;
  note: string | null;
}

async function prepareStashRecovery(root: string, prefix: string): Promise<StashRecovery[]> {
  let stdout = "";
  try {
    stdout = (await runGit(root, ["reflog", "show", "--format=%H%x00%gs%x00", "refs/stash"]))
      .stdout;
  } catch {
    return [];
  }
  const fields = stdout.split("\0");
  const entries: StashRecovery[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const oid = fields[index].replace(/^\s+|\s+$/g, "");
    if (!/^[0-9a-f]{40,64}$/i.test(oid)) continue;
    const ref = `${prefix}/stash/${String(entries.length).padStart(6, "0")}`;
    await runGit(root, ["update-ref", ref, oid]);
    const note = await runGit(root, ["notes", `--ref=${STASH_NOTES_REF}`, "show", oid])
      .then((result) => result.stdout)
      .catch(() => null);
    entries.push({
      ref,
      originalOid: oid,
      message: fields[index + 1].replace(/[\r\n]+$/g, ""),
      note,
    });
  }
  return entries;
}

async function migrateStashNotes(root: string, entries: StashRecovery[]): Promise<void> {
  const seen = new Set<string>();
  const env = {
    GIT_AUTHOR_NAME: "GitWebUI Recovery",
    GIT_AUTHOR_EMAIL: "recovery@gitwebui.invalid",
    GIT_COMMITTER_NAME: "GitWebUI Recovery",
    GIT_COMMITTER_EMAIL: "recovery@gitwebui.invalid",
  };
  for (const entry of entries) {
    if (entry.note === null || seen.has(entry.originalOid)) continue;
    seen.add(entry.originalOid);
    const rewrittenOid = await gitText(root, ["rev-parse", "--verify", entry.ref]);
    if (rewrittenOid === entry.originalOid) continue;
    await runGit(
      root,
      ["notes", `--ref=${STASH_NOTES_REF}`, "remove", "--ignore-missing", entry.originalOid],
      { env },
    );
    await runGit(
      root,
      ["notes", `--ref=${STASH_NOTES_REF}`, "add", "-f", "-F", "-", rewrittenOid],
      { env, input: entry.note },
    );
  }
}

async function createRecoveryBundle(
  root: string,
  head: string,
  internalPrefix: string,
): Promise<string> {
  await ensureConfigDir();
  const dir = configPath("history-backups");
  await fs.mkdir(dir, { recursive: true });
  const repoName = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repository";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(3).toString("hex");
  const bundle = path.join(dir, `${repoName}-${stamp}-${head.slice(0, 8)}-${suffix}.bundle`);

  // Bundle creation ignores reflog-only commits. Give every recovery tip a
  // temporary name long enough to build and verify the bundle, then remove the
  // names before rewriting. This protects reset/amend/deleted-branch recovery
  // without leaving the old graph reachable inside the repository afterward.
  const recoveryOids = new Set<string>();
  const reflog = await runGit(root, ["reflog", "show", "--all", "--format=%H"]);
  for (const oid of reflog.stdout.split(/\s+/)) if (/^[0-9a-f]{40,64}$/i.test(oid)) recoveryOids.add(oid);
  const origHead = await gitText(root, ["rev-parse", "--verify", "ORIG_HEAD^{commit}"]).catch(() => "");
  if (origHead) recoveryOids.add(origHead);
  const fetchHead = await readPseudoRefFile(root, "FETCH_HEAD");
  if (fetchHead) {
    for (const line of fetchHead.split(/\r?\n/)) {
      const oid = line.match(/^([0-9a-f]{40,64})(?:\s|$)/i)?.[1];
      if (oid) {
        const commit = await gitText(root, ["rev-parse", "--verify", `${oid}^{commit}`]).catch(
          () => "",
        );
        if (commit) recoveryOids.add(commit);
      }
    }
  }

  const refs: string[] = [];
  try {
    const recoveryRoot = await createSyntheticRecoveryRoot(root, [...recoveryOids]);
    if (recoveryRoot) {
      const ref = `${internalPrefix}/bundle/recovery-root`;
      await runGit(root, ["update-ref", ref, recoveryRoot]);
      refs.push(ref);
    }
    await runGit(root, ["bundle", "create", bundle, "--all"]);
    await runGit(root, ["bundle", "verify", bundle]);
  } finally {
    await deleteRefs(root, refs).catch(() => undefined);
  }
  return bundle;
}

async function createSyntheticRecoveryRoot(root: string, tips: string[]): Promise<string | null> {
  if (!tips.length) return null;
  let layer = [...new Set(tips)];
  if (layer.length === 1) return layer[0];
  const tree = (await runGit(root, ["mktree"], { input: "" })).stdout.trim();
  while (layer.length > 1) {
    const next: string[] = [];
    for (let start = 0; start < layer.length; start += 32) {
      const parents = layer.slice(start, start + 32);
      const args = ["commit-tree", tree];
      for (const parent of parents) args.push("-p", parent);
      next.push(
        (
          await runGit(root, args, {
            input: "GitWebUI recovery root\n",
            env: {
              GIT_AUTHOR_NAME: "GitWebUI Recovery",
              GIT_AUTHOR_EMAIL: "recovery@gitwebui.invalid",
              GIT_COMMITTER_NAME: "GitWebUI Recovery",
              GIT_COMMITTER_EMAIL: "recovery@gitwebui.invalid",
            },
          })
        ).stdout.trim(),
      );
    }
    layer = next;
  }
  return layer[0];
}

async function publicReflogSnapshot(root: string): Promise<string> {
  const { stdout } = await runGit(root, [
    "reflog",
    "show",
    "--all",
    "--format=%gD%x00%H%x00%gs",
  ]);
  return stdout
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("refs/gitwebui-history-rewrite/"))
    .sort()
    .join("\n");
}

async function requireReflogsUnchanged(root: string, expected: string): Promise<void> {
  if ((await publicReflogSnapshot(root)) !== expected) {
    throw httpError(409, "Repository reflogs changed while recovery data was prepared; nothing was rewritten");
  }
}

interface RefState {
  ref: string;
  oid: string;
  symref: string;
}

async function refSnapshot(root: string): Promise<RefState[]> {
  const { stdout } = await runGit(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)",
  ]);
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [ref, oid = "", symref = ""] = line.split("\0");
      return { ref, oid, symref };
    });
}

function publicRefs(refs: RefState[], internalPrefix: string): RefState[] {
  return refs.filter((item) => !item.ref.startsWith(`${internalPrefix}/`));
}

async function originalRefs(root: string): Promise<RefState[]> {
  const all = await refSnapshot(root);
  return all
    .filter((item) => item.ref.startsWith("refs/original/"))
    .map((item) => ({
      ref: item.ref.slice("refs/original/".length),
      oid: item.oid,
      symref: item.symref,
    }));
}

async function restoreRefSnapshot(
  root: string,
  before: RefState[],
  published: RefState[],
  internalPrefix: string,
): Promise<boolean> {
  if (!before.length) return false;
  const original = new Map(before.map((item) => [item.ref, item]));
  const currentBeforeRollback = await refSnapshot(root);
  const commands = ["start"];
  const handled = new Set<string>();
  for (const item of published) {
    if (item.symref) continue;
    handled.add(item.ref);
    const old = original.get(item.ref);
    if (old) commands.push(`update ${item.ref} ${old.oid} ${item.oid}`);
    else if (item.ref.startsWith(`${internalPrefix}/`)) {
      commands.push(`delete ${item.ref} ${item.oid}`);
    }
  }
  for (const item of currentBeforeRollback) {
    if (!item.symref && item.ref.startsWith(`${internalPrefix}/`) && !handled.has(item.ref)) {
      commands.push(`delete ${item.ref} ${item.oid}`);
    }
  }
  commands.push("prepare", "commit", "");
  try {
    await runGit(root, ["update-ref", "--stdin"], { input: commands.join("\n") });
  } catch {
    return false;
  }
  const restored = await refSnapshot(root);
  const restoredPublic = publicRefs(restored, internalPrefix);
  const current = new Map(restoredPublic.map((item) => [item.ref, item]));
  return before.every((item) => {
    const match = current.get(item.ref);
    return match?.oid === item.oid && match.symref === item.symref;
  });
}

async function deleteRefs(root: string, refs: string[]): Promise<void> {
  if (!refs.length) return;
  const commands = ["start", ...refs.map((ref) => `delete ${ref}`), "prepare", "commit", ""];
  await runGit(root, ["update-ref", "--stdin"], { input: commands.join("\n") });
}

async function refNames(root: string, prefix: string): Promise<string[]> {
  const { stdout } = await runGit(root, ["for-each-ref", "--format=%(refname)", prefix]);
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function importAndUpdateRefs(
  root: string,
  mirror: string,
  sourceRefs: RefState[],
  internalPrefix: string,
  expectedReflogs: string,
): Promise<RefState[]> {
  const candidate = new Map(
    (await refSnapshot(mirror))
      .filter((item) => !item.ref.startsWith("refs/original/"))
      .map((item) => [item.ref, item.oid]),
  );
  const liveBeforeImport = await refSnapshot(root);
  if (!sameRefSnapshot(sourceRefs, liveBeforeImport)) {
    throw httpError(409, "Repository refs changed while history was being prepared; nothing was rewritten");
  }
  const directRefs = sourceRefs.filter((item) => !item.symref);
  const imports: Array<{ ref: string; oid: string }> = [];
  for (let index = 0; index < directRefs.length; index++) {
    const source = directRefs[index];
    const oid = candidate.get(source.ref);
    if (!oid) throw new Error(`History rewrite did not produce ${source.ref}`);
    imports.push({ ref: `${internalPrefix}/import/${String(index).padStart(6, "0")}`, oid });
  }

  try {
    for (let start = 0; start < directRefs.length; start += 40) {
      const args = ["fetch", "--no-tags", "--no-write-fetch-head", mirror];
      for (let index = start; index < Math.min(directRefs.length, start + 40); index++) {
        args.push(`+${directRefs[index].ref}:${imports[index].ref}`);
      }
      await runGit(root, args);
    }
    for (const item of imports) {
      const imported = await gitText(root, ["rev-parse", "--verify", item.ref]);
      if (imported !== item.oid) throw new Error(`Failed to import rewritten object ${item.oid}`);
    }

    await requireReflogsUnchanged(root, expectedReflogs);

    const commands = ["start"];
    for (let index = 0; index < directRefs.length; index++) {
      const source = directRefs[index];
      commands.push(`update ${source.ref} ${imports[index].oid} ${source.oid}`);
    }
    commands.push("prepare", "commit", "");
    await runGit(root, ["update-ref", "--stdin"], { input: commands.join("\n") });
  } finally {
    await deleteRefs(root, imports.map((item) => item.ref)).catch(() => undefined);
  }
  return sourceRefs.map((item) => ({
    ref: item.ref,
    oid: candidate.get(item.ref)!,
    symref: item.symref,
  }));
}

function sameRefSnapshot(a: RefState[], b: RefState[]): boolean {
  if (a.length !== b.length) return false;
  const right = new Map(b.map((item) => [item.ref, item]));
  return a.every((item) => {
    const match = right.get(item.ref);
    return match?.oid === item.oid && match.symref === item.symref;
  });
}

async function verifyPathAbsent(root: string, target: string): Promise<void> {
  const refs = (await refNames(root, "refs")).filter((ref) => !ref.startsWith("refs/original/"));
  for (const ref of refs) {
    try {
      await runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
    } catch {
      // A custom ref may directly name a blob or tree. It has no commit history
      // for a repository path, so there is nothing to verify through git log.
      continue;
    }
    const { stdout } = await runGit(root, [
      "log",
      ref,
      "--format=%H",
      "--",
      `:(literal)${target}`,
    ]);
    if (stdout.trim()) {
      throw new Error(`Verification failed: ${target} is still present at ${ref}`);
    }
  }
}

function countChangedRefs(before: RefState[], after: RefState[]): number {
  const previous = new Map(before.map((item) => [item.ref, item.oid]));
  const current = new Map(after.map((item) => [item.ref, item.oid]));
  return new Set([...previous.keys(), ...current.keys()]).size === 0
    ? 0
    : [...new Set([...previous.keys(), ...current.keys()])].filter(
        (ref) => previous.get(ref) !== current.get(ref),
      ).length;
}

async function rebuildStashReflog(root: string, entries: StashRecovery[]): Promise<void> {
  const rewritten: Array<{ oid: string; message: string }> = [];
  for (const entry of entries) {
    const oid = await gitText(root, ["rev-parse", "--verify", entry.ref]);
    const parents = (await gitText(root, ["rev-list", "--parents", "-n", "1", oid])).split(/\s+/);
    if (parents.length >= 3) rewritten.push({ oid, message: entry.message });
  }
  await writeStashReflog(root, rewritten);
}

async function rebuildOriginalStashReflog(root: string, entries: StashRecovery[]): Promise<void> {
  await writeStashReflog(
    root,
    entries.map((entry) => ({ oid: entry.originalOid, message: entry.message })),
  );
}

async function writeStashReflog(
  root: string,
  entries: Array<{ oid: string; message: string }>,
): Promise<void> {
  await runGit(root, ["update-ref", "-d", "refs/stash"]).catch(() => undefined);
  let previous = "";
  for (const entry of [...entries].reverse()) {
    const args = ["update-ref", "--create-reflog", "-m", entry.message, "refs/stash", entry.oid];
    if (previous) args.push(previous);
    await runGit(root, args);
    previous = entry.oid;
  }
}

async function expireRecoveryReflogs(root: string): Promise<void> {
  // Preserve the rebuilt stash stack while removing every other local route to
  // the pre-rewrite commits. We cannot use --all because that would erase the
  // stash stack that was explicitly reconstructed with sanitized commits.
  await runGit(root, ["reflog", "expire", "--expire=now", "HEAD"]);
  for (const ref of await refNames(root, "refs")) {
    if (ref === "refs/stash") continue;
    try {
      await runGit(root, ["reflog", "exists", ref]);
    } catch {
      continue;
    }
    await runGit(root, ["reflog", "expire", "--expire=now", ref]);
  }
}

async function verifyRecoveryReflogsClean(root: string, target: string): Promise<void> {
  const { stdout } = await runGit(root, [
    "log",
    "--reflog",
    "--all",
    "--format=%H",
    "--",
    `:(literal)${target}`,
  ]);
  if (stdout.trim()) {
    throw new Error(`Verification failed: a reflog still reaches ${target}`);
  }
}

async function quarantineWorkingTreePath(root: string, target: string): Promise<string> {
  const rawGitDir = await gitText(root, ["rev-parse", "--git-common-dir"]);
  const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(root, rawGitDir);
  const container = path.join(
    gitDir,
    "gitwebui-history-backups",
    `${Date.now()}-${randomBytes(5).toString("hex")}`,
  );
  await fs.mkdir(container, { recursive: true });
  // Fixed disjoint slots avoid collisions with valid repository basenames
  // such as a tracked file literally named `index-before`.
  const destination = path.join(container, "worktree-content");
  try {
    await fs.rename(path.resolve(root, ...target.split("/")), destination);
    return destination;
  } catch (error) {
    await fs.rm(container, { recursive: true, force: true }).catch(() => undefined);
    throw httpError(
      409,
      `Could not safely move the selected working-tree path into recovery storage (${errorMessage(error)})`,
    );
  }
}

async function removeTargetFromIndexAtomically(
  root: string,
  target: string,
  worktreeQuarantine: string,
): Promise<IndexTransition> {
  const rawIndex = await gitText(root, ["rev-parse", "--git-path", "index"]);
  const indexPath = path.isAbsolute(rawIndex) ? rawIndex : path.resolve(root, rawIndex);
  const before = await fs.readFile(indexPath);
  const backupPath = path.join(path.dirname(worktreeQuarantine), "index-before");
  await fs.writeFile(backupPath, before, { flag: "wx" });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitwebui-history-live-index-"));
  const tempIndex = path.join(tempDir, "index");
  try {
    await fs.writeFile(tempIndex, before);
    await runGit(
      root,
      ["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", `:(literal)${target}`],
      { env: { GIT_INDEX_FILE: tempIndex } },
    );
    const after = await fs.readFile(tempIndex);
    await replaceIndexIfMatches(indexPath, before, after);
    return { indexPath, backupPath, before, after };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function restoreIndexTransition(transition: IndexTransition): Promise<boolean> {
  try {
    await replaceIndexIfMatches(transition.indexPath, transition.after, transition.before);
    return true;
  } catch {
    return false;
  }
}

async function replaceIndexIfMatches(
  indexPath: string,
  expected: Buffer,
  replacement: Buffer,
): Promise<void> {
  const lockPath = `${indexPath}.lock`;
  let lock: fs.FileHandle | null = null;
  try {
    const mode = (await fs.stat(indexPath)).mode;
    lock = await fs.open(lockPath, "wx", mode);
    const current = await fs.readFile(indexPath);
    if (!current.equals(expected)) {
      throw httpError(409, "The index changed during the guarded history update; it was not overwritten");
    }
    await lock.writeFile(replacement);
    await lock.sync();
    await lock.close();
    lock = null;
    await fs.rename(lockPath, indexPath);
  } finally {
    await lock?.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function restoreQuarantinedPath(
  root: string,
  target: string,
  quarantinePath: string,
): Promise<boolean> {
  if (!quarantinePath) return true;
  const destination = path.resolve(root, ...target.split("/"));
  try {
    await fs.access(destination);
    return false;
  } catch {
    /* The original path is free, so restoring cannot overwrite new work. */
  }
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(quarantinePath, destination);
    // The same directory can contain `index-before`. Never recursively remove
    // it: rollback may need that exact staged state if reverse index CAS fails.
    await fs.rmdir(path.dirname(quarantinePath)).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function requireUnchangedIndexAndWorktree(root: string, oldHead: string): Promise<void> {
  const currentIndexTree = await gitText(root, ["write-tree"]);
  const oldHeadTree = await gitText(root, ["rev-parse", `${oldHead}^{tree}`]);
  if (currentIndexTree !== oldHeadTree) {
    throw httpError(409, "The index changed while history was being rewritten; original refs were restored");
  }

  // The live index still matches old HEAD because filtering happened in an
  // isolated mirror. Compare the worktree against a second private old-HEAD
  // index as a content-aware guard before checking out the rewritten tip.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitwebui-history-index-"));
  const tempIndex = path.join(tempDir, "index");
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    await runGit(root, ["read-tree", oldHead], { env });
    // A just-created index has no stat cache. Refresh populates matching paths
    // but can still exit 1 while doing so, so the content-aware diff below is
    // the authoritative result.
    await runGit(root, ["update-index", "--really-refresh"], { env }).catch(() => undefined);
    await runGit(root, ["diff-files", "--quiet", "--ignore-submodules=none"], { env });
    const untracked = (
      await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], { env })
    ).stdout;
    if (untracked) {
      throw httpError(409, "Untracked files appeared while history was being rewritten; original refs were restored");
    }
  } catch (error) {
    throw httpError(
      409,
      `The working tree changed while history was being rewritten; original refs were restored (${errorMessage(error)})`,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function pseudoRefPath(root: string, name: string): Promise<string> {
  const raw = await gitText(root, ["rev-parse", "--git-path", name]);
  return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
}

async function readPseudoRefFile(root: string, name: string): Promise<string | null> {
  try {
    return await fs.readFile(await pseudoRefPath(root, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function requirePseudoRefUnchanged(
  root: string,
  name: string,
  expected: string | null,
): Promise<void> {
  if ((await readPseudoRefFile(root, name)) !== expected) {
    throw httpError(409, `${name} changed while history was being prepared; nothing was overwritten`);
  }
}

async function quarantinePseudoRefFile(
  root: string,
  name: string,
  expected: string | null,
): Promise<string> {
  if (expected === null) {
    await requirePseudoRefUnchanged(root, name, null);
    return "";
  }
  const file = await pseudoRefPath(root, name);
  const quarantine = `${file}.gitwebui-quarantine-${randomBytes(5).toString("hex")}`;
  await fs.rename(file, quarantine);
  const captured = await fs.readFile(quarantine, "utf8");
  if (captured !== expected) {
    await restorePseudoRefQuarantine(root, name, quarantine);
    throw httpError(409, `${name} changed while history was being prepared; it was not deleted`);
  }
  return quarantine;
}

async function requirePseudoRefAbsent(root: string, name: string): Promise<void> {
  if ((await readPseudoRefFile(root, name)) !== null) {
    throw httpError(409, `${name} was recreated while history cleanup was running; it was preserved`);
  }
}

async function deletePseudoRefQuarantine(quarantine: string): Promise<void> {
  if (quarantine) await fs.rm(quarantine);
}

async function restorePseudoRefQuarantine(
  root: string,
  name: string,
  quarantine: string,
): Promise<boolean> {
  if (!quarantine) return true;
  const file = await pseudoRefPath(root, name);
  try {
    await fs.access(file);
    return false;
  } catch {
    /* Restore only into an empty name; never overwrite a concurrent fetch. */
  }
  try {
    await fs.rename(quarantine, file);
    return true;
  } catch {
    return false;
  }
}

async function assumedUnchangedPaths(root: string): Promise<string[]> {
  const { stdout } = await runGit(root, ["ls-files", "-v", "-z"]);
  return stdout
    .split("\0")
    .filter((record) => record.length > 2 && /^[a-z] /.test(record))
    .map((record) => record.slice(2));
}

async function skipWorktreePaths(root: string): Promise<string[]> {
  const { stdout } = await runGit(root, ["ls-files", "-v", "-z"]);
  return stdout
    .split("\0")
    .filter((record) => record.length > 2 && record[0].toUpperCase() === "S" && record[1] === " ")
    .map((record) => record.slice(2));
}

async function gitText(root: string, args: string[]): Promise<string> {
  return (await runGit(root, args)).stdout.trim();
}

function errorMessage(error: unknown): string {
  if (error instanceof GitError) return error.stderr.trim() || error.message;
  return error instanceof Error ? error.message : String(error);
}
