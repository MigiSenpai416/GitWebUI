import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { configPath, ensureConfigDir } from "../config.js";
import { getStatus } from "./status.js";
import { GitError, runGit, runGitNullRecords } from "./gitRunner.js";
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
  historicalPaths: string[];
}

export interface HeadFileContent {
  path: string;
  head: string;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

export interface HistoryDeleteInput {
  path?: string;
  paths?: string[];
  expectedHead: string;
  confirmation: string;
  recursive?: boolean;
}

export interface HistoryDeleteResult {
  path: string;
  paths: string[];
  head: string;
  backupPath: string;
  worktreeBackupPath: string;
  indexBackupPath: string;
  rewrittenRefs: number;
  warnings: string[];
}

const activeRewrites = new Set<string>();
const activeMutations = new Map<string, number>();
const MAX_HEAD_FILE_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_DELETE_PATHS = 100;
const MAX_HISTORY_DELETE_PATH_CHARACTERS = 8_000;

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
export async function getHeadFileTree(
  root: string,
  includeHistorical = false,
): Promise<HeadFileTree> {
  const head = await verifiedHead(root);
  if (!head) return { head: null, entries: [], historicalPaths: [] };

  const { stdout } = await runGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "-l",
    "--full-tree",
    head,
  ]);
  const entries = parseLsTree(stdout);
  const historicalPaths = includeHistorical
    ? await historicalPathsOutsideHead(root, entries)
    : [];
  return { head, entries, historicalPaths };
}

interface HistoryDeleteTarget {
  path: string;
  recursive: boolean;
}

interface QuarantinedPath {
  target: string;
  path: string;
}

async function historicalPathsOutsideHead(
  root: string,
  entries: HeadFileEntry[],
): Promise<string[]> {
  const headPaths = new Set(entries.map((entry) => entry.path));
  return (await getHistoricalPaths(root)).filter((item) => !headPaths.has(item));
}

/** List file paths that occur in commits reachable from user-visible refs. */
export async function getHistoricalPaths(root: string): Promise<string[]> {
  const stashTips = await gitText(root, [
    "reflog",
    "show",
    "--format=%H",
    "refs/stash",
  ]).catch(() => "");
  return changedPaths(root, [
    "log",
    "--exclude=refs/notes/*",
    "--exclude=refs/gitwebui-history-rewrite/*",
    "--all",
    "--stdin",
    "--root",
    "-m",
    "--no-renames",
    "--format=",
    "--name-only",
    "-z",
  ], stashTips ? `${stashTips}\n` : "");
}

async function changedPaths(
  root: string,
  args: string[],
  input?: string,
): Promise<string[]> {
  return (await runGitNullRecords(root, args, input === undefined ? undefined : { input }))
    .sort((a, b) => a.localeCompare(b));
}

/** Read one file blob from the exact HEAD snapshot shown by the File Manager. */
export async function getHeadFileContent(
  root: string,
  value: string,
  expectedHead: string,
): Promise<HeadFileContent> {
  const target = validateGitTreePath(value);
  if (!/^[0-9a-fA-F]{40,64}$/.test(expectedHead)) {
    throw httpError(400, "A valid HEAD is required");
  }

  let head: string;
  try {
    head = await gitText(root, ["rev-parse", "--verify", `${expectedHead}^{commit}`]);
  } catch {
    throw httpError(409, "The File Manager HEAD snapshot is no longer available. Refresh it and try again");
  }
  if (head.toLowerCase() !== expectedHead.toLowerCase()) {
    throw httpError(400, "A full HEAD commit ID is required");
  }

  const { stdout } = await runGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "-l",
    "--full-tree",
    head,
  ]);
  const entry = parseLsTreeRecords(stdout).find((candidate) => candidate.path === target);
  if (!entry) throw httpError(409, `The path does not exist at the File Manager HEAD: ${target}`);
  if (entry.kind === "submodule" || entry.size == null) {
    throw httpError(422, "Git submodules do not have file content to preview");
  }
  if (entry.size > MAX_HEAD_FILE_PREVIEW_BYTES) {
    return { path: target, head, content: null, binary: false, tooLarge: true, size: entry.size };
  }

  const content = (await runGit(root, ["cat-file", "blob", entry.oid])).stdout;
  const binary = content.slice(0, 8000).includes(String.fromCharCode(0));
  return {
    path: target,
    head,
    content: binary ? null : content,
    binary,
    tooLarge: false,
    size: entry.size,
  };
}

/**
 * Remove selected exact repository paths (or one directory tree) from all
 * reachable refs. This is deliberately narrower than an arbitrary filter
 * command: every path is verified against reachable history and treated as
 * literal data so punctuation can never become shell/pathspec syntax.
 *
 * A bundle is made before refs move. The rewrite is allowed only in a clean,
 * non-shallow repository with one worktree, because resetting multiple indexes
 * after every checked-out branch changes cannot be done without risking work.
 */
export async function deletePathFromHistory(
  root: string,
  input: HistoryDeleteInput,
): Promise<HistoryDeleteResult> {
  const targets = normalizeHistoryDeleteTargets(input);
  const confirmationTarget = historyDeleteConfirmation(targets);
  if (input.confirmation !== confirmationTarget) {
    throw httpError(
      400,
      targets.length === 1
        ? "Confirmation must exactly match the repository path"
        : `Confirmation must exactly match ${confirmationTarget}`,
    );
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
  let quarantinedPaths: QuarantinedPath[] = [];
  let worktreeBackupPath = "";
  let workingTreeBackupDirectory = "";
  let fetchHeadBefore: string | null = null;
  let fetchHeadQuarantine = "";
  let origHeadBefore: string | null = null;
  let origHeadQuarantine = "";
  let reflogsBefore = "";
  let cleanupIrreversible = false;
  let indexTransition: IndexTransition | null = null;
  try {
    await requireFilterRepo(root);
    const preflightResult = await preflight(root, targets, input.expectedHead);
    const oldHead = preflightResult.head;
    refsBefore = preflightResult.refs;
    fetchHeadBefore = await readPseudoRefFile(root, "FETCH_HEAD");
    origHeadBefore = await readPseudoRefFile(root, "ORIG_HEAD");
    reflogsBefore = await publicReflogSnapshot(root);
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
    // Platform filename guards are disabled only while the bare mirror replays
    // tree objects; no checkout occurs and the live repository stays protected.
    try {
      await runGit(mirrorDir, [
        "-c",
        "core.protectNTFS=false",
        "-c",
        "core.protectHFS=false",
        "filter-repo",
        "--force",
        "--partial",
        "--invert-paths",
        ...filterPathArguments(targets),
        "--prune-empty=never",
        "--prune-degenerate=never",
        "--preserve-commit-hashes",
        "--preserve-commit-encoding",
      ]);
    } catch (error) {
      if (error instanceof GitError && /invalid path/i.test(error.message)) {
        throw httpError(
          422,
          `Git could not replay a historical filename in the isolated mirror. No live refs were changed, and GitWebUI did not remove or rename unrelated paths. Retry from Linux/WSL or repair that historical path explicitly. (${errorMessage(error)})`,
        );
      }
      throw error;
    }
    await migrateStashNotes(mirrorDir, stashRecovery);

    // Validate in the isolated mirror before a single ref in the live repo
    // moves, then import its objects and atomically exchange all ref tips.
    const mirrorRefs = await refSnapshot(mirrorDir);
    await verifyPathsAbsent(mirrorDir, targets, mirrorRefs);
    await runGit(mirrorDir, ["fsck", "--full", "--no-reflogs"]);
    publishedRefs = await importAndUpdateRefs(
      root,
      mirrorDir,
      mirrorRefs,
      sourceRefs,
      reflogsBefore,
    );
    await verifyPathsAbsent(root, targets, publishedRefs);
    await requireUnchangedIndexAndWorktree(root, oldHead);

    const newHead = await verifiedHead(root);
    if (!newHead) throw new Error("History rewrite left the current branch without a HEAD");
    const workingTreeBackup = await quarantineWorkingTreePaths(
      root,
      targets,
      preflightResult.presentAtHead,
    );
    quarantinedPaths = workingTreeBackup.paths;
    worktreeBackupPath = workingTreeBackup.path;
    workingTreeBackupDirectory = workingTreeBackup.directory;
    // Rewriting selected paths leaves every other entry in the tip tree unchanged.
    // Update only the index; selected worktree paths were atomically moved
    // to a recovery location, so concurrent edits elsewhere are never erased.
    indexTransition = await removeTargetsFromIndexAtomically(
      root,
      targets,
      workingTreeBackupDirectory,
      preflightResult.presentAtHead,
    );
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
    await verifyRecoveryReflogsClean(root, targets);
    await requirePseudoRefAbsent(root, "FETCH_HEAD");
    await requirePseudoRefAbsent(root, "ORIG_HEAD");
    await deleteRefs(root, await refNames(root, internalPrefix));
    await deletePseudoRefQuarantine(fetchHeadQuarantine);
    await deletePseudoRefQuarantine(origHeadQuarantine);

    return {
      path: targets[0].path,
      paths: targets.map((target) => target.path),
      head: newHead,
      backupPath,
      worktreeBackupPath,
      indexBackupPath: indexTransition.backupPath,
      rewrittenRefs: countChangedRefs(refsBefore, await refSnapshot(root)),
      warnings: [
        quarantinedPaths.length
          ? `The removed working-tree content and pre-rewrite index were preserved at ${workingTreeBackupDirectory} so racing edits cannot be lost.`
          : targets.length === 1
            ? `The pre-rewrite index was preserved at ${workingTreeBackupDirectory}; the selected path was absent from HEAD, so its current working-tree location was not changed.`
            : `The pre-rewrite index was preserved at ${workingTreeBackupDirectory}; the selected paths were absent from HEAD, so their current working-tree locations were not changed.`,
        "Unreachable pre-rewrite Git objects may remain until normal pruning; use a verified fresh clone and remove the old repository plus recovery artifacts for a sensitive-data purge.",
        "Non-stash reflogs were cleared; their prior names, messages, timestamps, and ordering are available only indirectly through the recovery bundle's commits.",
      ],
    };
  } catch (error) {
    if (cleanupIrreversible) {
      throw httpError(
        500,
        `History refs were rewritten, but recovery-route cleanup did not complete. Do not retry blindly. Recovery bundle: ${backupPath}.${workingTreeBackupDirectory ? ` Repository-state backup directory: ${workingTreeBackupDirectory}.` : ""} ${errorMessage(error)}`,
      );
    }
    if (publishedRefs) {
      const restored = await restoreRefSnapshot(root, refsBefore, publishedRefs, internalPrefix);
      if (restored) {
        const indexRestored = indexTransition
          ? await restoreIndexTransition(indexTransition)
          : true;
        const worktreeRestored = await restoreQuarantinedPaths(root, quarantinedPaths);
        await restorePseudoRefQuarantine(root, "FETCH_HEAD", fetchHeadQuarantine);
        await restorePseudoRefQuarantine(root, "ORIG_HEAD", origHeadQuarantine);
        await rebuildOriginalStashReflog(root, stashRecovery).catch(() => undefined);
        throw httpError(
          500,
          `History rewrite failed and the original refs were restored.${workingTreeBackupDirectory ? ` Repository-state backup directory: ${workingTreeBackupDirectory}.` : ""}${indexRestored ? "" : " The live index changed again and was not overwritten."}${worktreeRestored ? "" : ` Some working-tree copies remain under ${workingTreeBackupDirectory}.`} Recovery bundle: ${backupPath}. ${errorMessage(error)}`,
        );
      }
      throw httpError(
        500,
        `History rewrite failed, but refs changed again and were not overwritten during rollback. Recovery bundle: ${backupPath}.${workingTreeBackupDirectory ? ` Repository-state backup directory: ${workingTreeBackupDirectory}.` : ""} ${errorMessage(error)}`,
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
  return parseLsTreeRecords(stdout).map(({ oid: _oid, ...entry }) => entry);
}

function parseLsTreeRecords(stdout: string): Array<HeadFileEntry & { oid: string }> {
  const entries: Array<HeadFileEntry & { oid: string }> = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const [mode, type, oid, rawSize] = meta;
    if (!mode || !type || !oid) continue;
    entries.push({
      path: record.slice(tab + 1),
      mode,
      oid,
      kind: mode === "120000" ? "symlink" : type === "commit" ? "submodule" : "file",
      size: rawSize && /^\d+$/.test(rawSize) ? Number(rawSize) : null,
    });
  }
  return entries;
}

interface PreflightResult {
  head: string;
  refs: RefState[];
  presentAtHead: Set<string>;
}

async function preflight(
  root: string,
  targets: HistoryDeleteTarget[],
  expectedHead: string,
): Promise<PreflightResult> {
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

  const presentAtHead = await pathsAtHead(root, head, targets);
  const absent = targets.filter((target) => !presentAtHead.has(target.path));
  if (absent.length) {
    const historicalPaths = await getHistoricalPaths(root);
    for (const target of absent) {
      if (!pathExistsInHistory(historicalPaths, target.path, target.recursive)) {
        throw httpError(409, `The path no longer exists in reachable history: ${target.path}`);
      }
    }
  }
  for (const target of targets.filter((item) => presentAtHead.has(item.path))) {
    validateWorktreePath(target.path);
  }
  await rejectFilesystemAliasedSelections(root, head, targets, presentAtHead);

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

  const refs = await refSnapshot(root);
  if (refs.some((item) => refAtOrBelow(item.ref, "refs/replace"))) {
    throw httpError(409, "Remove Git replacement refs before rewriting history");
  }
  if (refs.some((item) => refAtOrBelow(item.ref, "refs/original"))) {
    throw httpError(
      409,
      "This repository already has refs/original backup refs from an earlier rewrite; resolve them first",
    );
  }
  if (refs.some((item) => refAtOrBelow(item.ref, "refs/gitwebui-history-rewrite"))) {
    throw httpError(
      409,
      "An interrupted GitWebUI history rewrite left recovery refs; resolve them before retrying",
    );
  }

  rejectNonCommitRefs(refs);

  return { head, refs, presentAtHead };
}

function normalizeHistoryDeleteTargets(input: HistoryDeleteInput): HistoryDeleteTarget[] {
  const usesPathArray = input.paths !== undefined;
  const requested = input.paths ?? [input.path ?? ""];
  if (!Array.isArray(requested) || requested.length === 0) {
    throw httpError(400, "At least one repository path is required");
  }
  if (requested.length > MAX_HISTORY_DELETE_PATHS) {
    throw httpError(400, `At most ${MAX_HISTORY_DELETE_PATHS} files can be deleted at once`);
  }
  if (requested.length > 1 && input.recursive === true) {
    throw httpError(400, "Multiple selections must be exact file paths, not recursive directories");
  }
  const paths = requested.map(validateHistoryPath);
  if (new Set(paths).size !== paths.length) {
    throw httpError(400, "Duplicate repository paths are not allowed");
  }
  if (paths.reduce((total, target) => total + target.length, 0) > MAX_HISTORY_DELETE_PATH_CHARACTERS) {
    throw httpError(400, "The selected repository paths are too long to rewrite safely in one operation");
  }
  return paths.map((target) => ({
    path: target,
    recursive: paths.length === 1
      ? usesPathArray ? input.recursive === true : input.recursive !== false
      : false,
  }));
}

function historyDeleteConfirmation(targets: HistoryDeleteTarget[]): string {
  return targets.length === 1 ? targets[0].path : `DELETE ${targets.length} FILES`;
}

function filterPathArguments(targets: HistoryDeleteTarget[]): string[] {
  if (targets.length === 1 && targets[0].recursive) {
    return [`--path=${targets[0].path}`];
  }
  const alternatives = targets.map((target) => escapePathRegex(target.path)).join("|");
  return [`--path-regex=\\A(?:${alternatives})\\Z`];
}

function validateHistoryPath(value: string): string {
  const target = String(value ?? "");
  if (!target || target === "." || target === "..") {
    throw httpError(400, "A repository-relative file or directory path is required");
  }
  if (
    target.includes("\0") ||
    target.startsWith("/") ||
    target.endsWith("/")
  ) {
    throw httpError(400, "Invalid repository path");
  }
  const parts = target.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw httpError(400, "Invalid repository path");
  }
  return target;
}

function validateWorktreePath(target: string): void {
  if (process.platform === "win32" && target.includes("\\")) {
    throw httpError(
      409,
      "This Git path cannot be safely changed through the Windows working tree; delete it after it is absent from HEAD or use a case-sensitive checkout",
    );
  }
}

function validateGitTreePath(value: string): string {
  const target = String(value ?? "");
  if (!target || target.includes("\0")) {
    throw httpError(400, "A valid Git tree path is required");
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

async function pathsAtHead(
  root: string,
  head: string,
  targets: HistoryDeleteTarget[],
): Promise<Set<string>> {
  const { stdout } = await runGit(root, [
    "ls-tree",
    "-z",
    head,
    "--",
    ...targets.map((target) => `:(literal)${target.path}`),
  ]);
  const matches = stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      return {
        path: record.slice(tab + 1),
        type: record.slice(0, tab).trim().split(/\s+/)[1] ?? "",
      };
    });
  return new Set(
    targets
      .filter((target) => {
        const match = matches.find((item) => item.path === target.path);
        return !!match && (target.recursive || match.type !== "tree");
      })
      .map((target) => target.path),
  );
}

function pathExistsInHistory(paths: string[], target: string, recursive: boolean): boolean {
  return paths.some((item) => item === target || (recursive && item.startsWith(`${target}/`)));
}

function escapePathRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function rejectFilesystemAliasedSelections(
  root: string,
  head: string,
  targets: HistoryDeleteTarget[],
  presentAtHead: Set<string>,
): Promise<void> {
  if (process.platform !== "win32") return;
  const { stdout } = await runGit(root, ["ls-tree", "-r", "-z", "--name-only", head]);
  const paths = stdout.split("\0").filter(Boolean);
  const selectedTargets = targets.filter((target) => presentAtHead.has(target.path));
  const selected = paths.filter((item) => selectedTargets.some(
    (target) => item === target.path || (target.recursive && item.startsWith(`${target.path}/`)),
  ));
  const selectedPaths = new Set(selected);
  const physicalSelections = selected.map(windowsFilesystemPath);
  const selectedPhysicalPaths = new Set(physicalSelections);
  const retained = paths.filter((item) => !selectedPaths.has(item));
  const aliases = selectedPhysicalPaths.size !== physicalSelections.length || selectedTargets.some((target) => {
    const foldedTarget = windowsFilesystemPath(target.path);
    return retained.some((item) => {
      const folded = windowsFilesystemPath(item);
      return (
        folded === foldedTarget ||
        (target.recursive && folded.startsWith(`${foldedTarget}/`)) ||
        selectedPhysicalPaths.has(folded)
      );
    });
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

function rejectNonCommitRefs(refs: RefState[]): void {
  for (const ref of refs) {
    if (!refCommitOid(ref)) {
      throw httpError(
        409,
        `History rewriting is unavailable while ${ref.ref} directly names a tree or blob; remove or convert that ref first`,
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
  objectType: string;
  peeledOid: string;
  peeledType: string;
}

async function refSnapshot(root: string, prefix?: string): Promise<RefState[]> {
  const args = [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)%00%(*objectname)%00%(*objecttype)",
  ];
  if (prefix) args.push(prefix);
  const { stdout } = await runGit(root, args);
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [
        ref,
        oid = "",
        symref = "",
        objectType = "",
        peeledOid = "",
        peeledType = "",
      ] = line.split("\0");
      return { ref, oid, symref, objectType, peeledOid, peeledType };
    });
}

function refCommitOid(ref: RefState): string | null {
  if (ref.objectType === "commit") return ref.oid;
  if (ref.peeledType === "commit") return ref.peeledOid;
  return null;
}

function refAtOrBelow(ref: string, prefix: string): boolean {
  return ref === prefix || ref.startsWith(`${prefix}/`);
}

function publicRefs(refs: RefState[], internalPrefix: string): RefState[] {
  return refs.filter((item) => !item.ref.startsWith(`${internalPrefix}/`));
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
    await runGit(root, ["update-ref", "--no-deref", "--stdin"], {
      input: commands.join("\n"),
    });
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
  await runGit(root, ["update-ref", "--no-deref", "--stdin"], {
    input: commands.join("\n"),
  });
}

async function refNames(root: string, prefix: string): Promise<string[]> {
  const { stdout } = await runGit(root, ["for-each-ref", "--format=%(refname)", prefix]);
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function importAndUpdateRefs(
  root: string,
  mirror: string,
  rewrittenRefs: RefState[],
  sourceRefs: RefState[],
  expectedReflogs: string,
): Promise<RefState[]> {
  const candidate = new Map(
    rewrittenRefs
      .filter((item) => !item.ref.startsWith("refs/original/"))
      .map((item) => [item.ref, item]),
  );
  const liveBeforeImport = await refSnapshot(root);
  if (!sameRefSnapshot(sourceRefs, liveBeforeImport)) {
    throw httpError(409, "Repository refs changed while history was being prepared; nothing was rewritten");
  }
  for (const source of sourceRefs) {
    const rewritten = candidate.get(source.ref);
    if (!rewritten) throw new Error(`History rewrite did not produce ${source.ref}`);
    if (source.symref) {
      const target = candidate.get(source.symref);
      if (!target || rewritten.oid !== target.oid) {
        throw new Error(`History rewrite did not preserve symbolic ref ${source.ref}`);
      }
    }
  }
  const directRefs = sourceRefs.filter((item) => !item.symref);
  if (directRefs.length) {
    // Fetch only objects, with no destination refs. Stdin avoids the Windows
    // argv limit, and leaving the destination side absent avoids loose-ref
    // path limits and any temporary namespace that another Git process could
    // race with.
    await runGit(
      root,
      [
        "fetch",
        "--atomic",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-commit-graph",
        "--stdin",
        mirror,
      ],
      { input: `${directRefs.map((item) => item.ref).join("\n")}\n` },
    );
  }

  const expectedObjects = new Map(
    directRefs.map((item) => {
      const rewritten = candidate.get(item.ref)!;
      return [rewritten.oid, rewritten.objectType];
    }),
  );
  if (expectedObjects.size) {
    const { stdout } = await runGit(
      root,
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      { input: `${[...expectedObjects.keys()].join("\n")}\n` },
    );
    const imported = new Map(
      stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [oid, type = ""] = line.split(" ");
          return [oid, type];
        }),
    );
    for (const [oid, type] of expectedObjects) {
      if (imported.get(oid) !== type) {
        throw new Error(`Failed to import rewritten object ${oid}`);
      }
    }
  }

  if (!sameRefSnapshot(sourceRefs, await refSnapshot(root))) {
    throw httpError(
      409,
      "Repository refs changed while rewritten objects were imported; nothing was rewritten",
    );
  }

  await requireReflogsUnchanged(root, expectedReflogs);

  const commands = ["start"];
  for (const source of directRefs) {
    commands.push(`update ${source.ref} ${candidate.get(source.ref)!.oid} ${source.oid}`);
  }
  commands.push("prepare", "commit", "");
  await runGit(root, ["update-ref", "--no-deref", "--stdin"], {
    input: commands.join("\n"),
  });
  return sourceRefs.map((item) => ({
    ...candidate.get(item.ref)!,
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

async function verifyPathsAbsent(
  root: string,
  targets: HistoryDeleteTarget[],
  expectedRefs: RefState[],
): Promise<void> {
  for (const target of targets) {
    await verifyPathAbsent(root, target.path, expectedRefs, target.recursive);
  }
}

async function verifyPathAbsent(
  root: string,
  target: string,
  expectedRefs: RefState[],
  recursive: boolean,
): Promise<void> {
  const refs = expectedRefs.filter(
    (item) => !item.ref.startsWith("refs/original/") && !item.ref.startsWith("refs/notes/"),
  );
  const commits = [...new Set(refs.map(refCommitOid).filter((oid): oid is string => Boolean(oid)))];
  const pathspecs = [
    `:(literal)${target}`,
    ...(recursive ? [] : [`:(exclude,literal)${target}/`]),
  ];
  if (commits.length) {
    const { stdout } = await runGit(
      root,
      ["rev-list", "--stdin", "-m", "--max-count=1", "--no-renames", "--", ...pathspecs],
      { input: `${commits.join("\n")}\n` },
    );
    if (stdout.trim()) {
      for (const ref of refs) {
        const oid = refCommitOid(ref);
        if (!oid) continue;
        const result = await runGit(root, [
          "rev-list",
          "-m",
          "--max-count=1",
          "--no-renames",
          oid,
          "--",
          ...pathspecs,
        ]);
        if (result.stdout.trim()) {
          throw new Error(`Verification failed: ${target} is still present at ${ref.ref}`);
        }
      }
      throw new Error(`Verification failed: ${target} is still present in reachable history`);
    }
  }
  if (!sameRefSnapshot(expectedRefs, await refSnapshot(root))) {
    throw httpError(409, "Repository refs changed during history verification");
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
  const reflogs = new Set<string>(["HEAD"]);
  const { stdout } = await runGit(root, ["reflog", "show", "--all", "--format=%gD"]);
  for (const line of stdout.split(/\r?\n/)) {
    const marker = line.lastIndexOf("@{");
    if (marker > 0 && line.endsWith("}")) reflogs.add(line.slice(0, marker));
  }
  reflogs.delete("refs/stash");
  for (const batch of argumentBatches([...reflogs], 8_000)) {
    await runGit(root, ["reflog", "expire", "--expire=now", ...batch]);
  }
}

function argumentBatches(values: string[], maxLength: number): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const value of values) {
    const cost = value.length + 3;
    if (batch.length && length + cost > maxLength) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(value);
    length += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function verifyRecoveryReflogsClean(
  root: string,
  targets: HistoryDeleteTarget[],
): Promise<void> {
  for (const target of targets) {
    const pathspecs = [
      `:(literal)${target.path}`,
      ...(target.recursive ? [] : [`:(exclude,literal)${target.path}/`]),
    ];
    const { stdout } = await runGit(root, [
      "log",
      "--reflog",
      "--exclude=refs/notes/*",
      "--all",
      "-m",
      "--format=%H",
      "--",
      ...pathspecs,
    ]);
    if (stdout.trim()) {
      throw new Error(`Verification failed: a reflog still reaches ${target.path}`);
    }
  }
}

async function quarantineWorkingTreePaths(
  root: string,
  targets: HistoryDeleteTarget[],
  presentAtHead: Set<string>,
): Promise<{ directory: string; path: string; paths: QuarantinedPath[] }> {
  const rawGitDir = await gitText(root, ["rev-parse", "--git-common-dir"]);
  const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(root, rawGitDir);
  const container = path.join(
    gitDir,
    "gitwebui-history-backups",
    `${Date.now()}-${randomBytes(5).toString("hex")}`,
  );
  await fs.mkdir(container, { recursive: true });
  const currentTargets = targets.filter((target) => presentAtHead.has(target.path));
  if (!currentTargets.length) return { directory: container, path: "", paths: [] };
  const batch = targets.length > 1;
  // Fixed disjoint slots avoid collisions with valid repository basenames
  // such as a tracked file literally named `index-before`.
  const contentPath = path.join(container, "worktree-content");
  const moved: QuarantinedPath[] = [];
  try {
    if (batch) await fs.mkdir(contentPath);
    for (let index = 0; index < currentTargets.length; index++) {
      const target = currentTargets[index].path;
      const destination = batch
        ? path.join(contentPath, String(index + 1).padStart(3, "0"))
        : contentPath;
      await fs.rename(path.resolve(root, ...target.split("/")), destination);
      moved.push({ target, path: destination });
    }
    if (batch) {
      await fs.writeFile(
        path.join(contentPath, "paths.json"),
        `${JSON.stringify(moved.map((item) => ({ target: item.target, backup: path.relative(contentPath, item.path) })), null, 2)}\n`,
        { flag: "wx" },
      );
    }
    return { directory: container, path: contentPath, paths: moved };
  } catch (error) {
    const restored = await restoreQuarantinedPaths(root, moved);
    if (restored) await fs.rm(container, { recursive: true, force: true }).catch(() => undefined);
    throw httpError(
      409,
      `Could not safely move the selected working-tree paths into recovery storage${restored ? "" : `; recovery copies remain under ${container}`} (${errorMessage(error)})`,
    );
  }
}

async function removeTargetsFromIndexAtomically(
  root: string,
  targets: HistoryDeleteTarget[],
  backupDirectory: string,
  presentAtHead: Set<string>,
): Promise<IndexTransition> {
  const rawIndex = await gitText(root, ["rev-parse", "--git-path", "index"]);
  const indexPath = path.isAbsolute(rawIndex) ? rawIndex : path.resolve(root, rawIndex);
  const before = await fs.readFile(indexPath);
  const backupPath = path.join(backupDirectory, "index-before");
  await fs.writeFile(backupPath, before, { flag: "wx" });
  const selected = targets.filter((target) => presentAtHead.has(target.path));
  if (!selected.length) {
    return { indexPath, backupPath, before, after: before };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitwebui-history-live-index-"));
  const tempIndex = path.join(tempDir, "index");
  try {
    await fs.writeFile(tempIndex, before);
    await runGit(
      root,
      [
        "rm",
        "-r",
        "-f",
        "--cached",
        "--ignore-unmatch",
        "--",
        ...selected.map((target) => `:(literal)${target.path}`),
      ],
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

async function restoreQuarantinedPaths(
  root: string,
  quarantined: QuarantinedPath[],
): Promise<boolean> {
  if (!quarantined.length) return true;
  for (const item of quarantined) {
    const destination = path.resolve(root, ...item.target.split("/"));
    try {
      await fs.access(destination);
      return false;
    } catch {
      /* The original path is free, so restoring cannot overwrite new work. */
    }
  }
  for (const item of quarantined) {
    const destination = path.resolve(root, ...item.target.split("/"));
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(item.path, destination);
    } catch {
      return false;
    }
  }
  return true;
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
