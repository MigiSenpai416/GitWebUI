import { useStore } from "../state/store";
import type { CommitFile } from "../types";
import { ChangedFiles } from "./ChangedFiles";
import { IconClose } from "./icons";
import "./CommitDetails.css";

export function CommitDetails() {
  const hash = useStore((s) => s.selectedCommitHash);
  const commits = useStore((s) => s.commits);
  const files = useStore((s) => s.commitFiles);
  const loading = useStore((s) => s.loadingCommitFiles);
  const selectCommit = useStore((s) => s.selectCommit);
  const status = useStore((s) => s.status);
  const openFile = useStore((s) => s.openFile);
  const selectedFile = useStore((s) => s.selectedFile);

  const commit = commits.find((c) => c.hash === hash);
  if (!commit) return null;

  const wipCount = status.staged.length + status.unstaged.length;

  const isActive = (f: CommitFile) =>
    selectedFile?.source === "commit" &&
    selectedFile.hash === commit.hash &&
    selectedFile.path === f.path;

  const open = (f: CommitFile) =>
    openFile({
      path: f.path,
      oldPath: f.oldPath,
      source: "commit",
      hash: commit.hash,
      status: f.status,
    });

  return (
    <div className="commit-details">
      {wipCount > 0 && (
        <div className="cd-wip-banner">
          <span className="cd-wip-text">
            {wipCount} file change{wipCount === 1 ? "" : "s"} in working directory
          </span>
          <button className="cd-wip-btn" onClick={() => selectCommit(null)}>
            View Changes
          </button>
        </div>
      )}

      <div className="cd-header">
        <span className="cd-title-label">Commit</span>
        <span className="cd-hash">{commit.shortHash}</span>
        <div className="spacer" />
        <button className="icon-btn" title="Back to changes" onClick={() => selectCommit(null)}>
          <IconClose width={13} height={13} />
        </button>
      </div>

      <div className="cd-message">
        <div className="cd-subject">{commit.subject}</div>
        {commit.body && <pre className="cd-body">{commit.body}</pre>}
      </div>

      <div className="cd-meta">
        <div className="cd-meta-row">
          <span className="cd-meta-key">Author</span>
          <span className="cd-meta-val">
            {commit.author} <span className="cd-email">&lt;{commit.email}&gt;</span>
          </span>
        </div>
        <div className="cd-meta-row">
          <span className="cd-meta-key">Date</span>
          <span className="cd-meta-val">{formatDate(commit.dateISO)}</span>
        </div>
        <div className="cd-meta-row">
          <span className="cd-meta-key">Commit</span>
          <span className="cd-meta-val cd-mono">{commit.hash}</span>
        </div>
        {commit.parents.length > 0 && (
          <div className="cd-meta-row">
            <span className="cd-meta-key">Parents</span>
            <span className="cd-meta-val cd-mono">
              {commit.parents.map((p) => p.slice(0, 8)).join("  ")}
            </span>
          </div>
        )}
      </div>

      <ChangedFiles files={files} loading={loading} isActive={isActive} onOpen={open} />
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
