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
}

export interface Remote {
  name: string;
  url: string;
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
