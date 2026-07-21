// Shared API shapes (kept in sync with server/src/git/*).

export interface CommitRef {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
  isHead?: boolean;
}

export interface Commit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  dateISO: string;
  subject: string;
  body: string;
  refs: CommitRef[];
}

export type ChangeStatus = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";

export interface FileChange {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  staged: boolean;
}

export interface StatusResult {
  staged: FileChange[];
  unstaged: FileChange[];
}

export interface CommitFile {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
}

export type RowType = "context" | "add" | "del";

export interface DiffRow {
  type: RowType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  noNewline?: boolean;
}

export type DiffSource = "unstaged" | "staged" | "commit";

export interface DiffResult {
  path: string;
  oldPath: string | null;
  rows: DiffRow[];
  language: string;
  binary: boolean;
  fileContent: string | null;
  empty: boolean;
}

export interface RepoInfo {
  root: string;
  branch: string;
  head: string | null;
}

export interface Branch {
  name: string;
  current: boolean;
  shortHash: string;
  upstream: string | null;
  /** Commits the branch has that its upstream lacks (0 without an upstream). */
  ahead: number;
  /** Commits the upstream has that the branch lacks. */
  behind: number;
  /** The upstream ref no longer exists on the remote. */
  upstreamGone: boolean;
}

export interface Remote {
  name: string;
  url: string;
}

export interface RemoteBranch {
  name: string;
  remote: string;
  shortName: string;
  ref: string;
  shortHash: string;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  isMain: boolean;
  current: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
}

export interface StashEntry {
  index: number;
  ref: string;
  message: string;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubStatus {
  configured: boolean;
  user: GitHubUser | null;
  error?: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface IdentityInfo {
  /** Manually-set identity, or null if none saved. */
  manual: CommitIdentity | null;
  /** Identity derived from a connected GitHub account, or null. */
  github: CommitIdentity | null;
  /** What commits will actually use (github wins, else manual, else git config). */
  effective: CommitIdentity | null;
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  cloneUrl: string;
  description: string | null;
  updatedAt: string | null;
}

/** A repository the pull-request dialog can target, with its fork lineage. */
export interface GitHubRepoRef {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  isFork: boolean;
  parentFullName: string | null;
}

/** A user selectable as a reviewer or assignee. */
export interface GitHubAccount {
  login: string;
  avatarUrl: string | null;
}

export interface GitHubLabel {
  name: string;
  color: string;
  description: string | null;
}

/** A pull-request template found in the working tree. */
export interface PrTemplate {
  path: string;
  name: string;
}

/** Everything the Create Pull Request dialog needs on open. */
export interface PrContext {
  viewer: GitHubUser | null;
  head: {
    branch: string;
    branches: Branch[];
    repo: GitHubRepoRef | null;
    remote: string | null;
  };
  baseCandidates: GitHubRepoRef[];
  defaults: { baseRepo: string | null; baseBranch: string | null };
  templates: PrTemplate[];
}

/** Reviewer/assignee/label options for a chosen target repository. */
export interface PrMeta {
  collaborators: GitHubAccount[];
  assignees: GitHubAccount[];
  labels: GitHubLabel[];
}

export interface CreatePrInput {
  baseRepo: string;
  base: string;
  headRepo: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  reviewers: string[];
  assignees: string[];
  labels: string[];
}

export interface CreatedPr {
  number: number;
  htmlUrl: string;
  /** Non-fatal problems, e.g. reviewers that couldn't be requested. */
  warnings: string[];
}

export type MergeKind = "merge" | "rebase" | "cherry-pick" | "revert";

/** State of an in-progress merge/rebase/cherry-pick/revert and its conflicts. */
export interface MergeState {
  active: boolean;
  kind: MergeKind | null;
  intoBranch: string;
  fromLabel: string | null;
  conflicted: string[];
  message: string;
}

/** Three-way content for a single conflicted file. */
export interface ConflictFileData {
  path: string;
  /** Working-tree file with conflict markers. */
  merged: string;
  oursLabel: string;
  theirsLabel: string;
}

/** Identifies which file's diff is open in the viewer. */
export interface SelectedFile {
  path: string;
  oldPath?: string;
  source: DiffSource;
  /** Present when source === "commit". */
  hash?: string;
  /** Whether a working-change file is currently staged (drives Stage/Unstage button). */
  staged?: boolean;
  status?: ChangeStatus;
}
