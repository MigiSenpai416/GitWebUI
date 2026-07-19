import { useStore } from "../state/store";
import { FileRow } from "./FileRow";
import "./CommitDetails.css";

export function CommitDetails() {
  const hash = useStore((s) => s.selectedCommitHash);
  const commits = useStore((s) => s.commits);
  const files = useStore((s) => s.commitFiles);
  const loading = useStore((s) => s.loadingCommitFiles);
  const selectCommit = useStore((s) => s.selectCommit);
  const openFile = useStore((s) => s.openFile);
  const selectedFile = useStore((s) => s.selectedFile);

  const commit = commits.find((c) => c.hash === hash);
  if (!commit) return null;

  return (
    <div className="commit-details">
      <div className="cd-header">
        <span className="cd-title-label">Commit</span>
        <span className="cd-hash">{commit.shortHash}</span>
        <div className="spacer" />
        <button className="icon-btn" title="Back to changes" onClick={() => selectCommit(null)}>
          ✕
        </button>
      </div>

      <div className="cd-scroll">
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

        <div className="cd-files-head">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </div>
        {loading ? (
          <div className="section-empty">Loading…</div>
        ) : (
          files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              active={
                selectedFile?.source === "commit" &&
                selectedFile.hash === commit.hash &&
                selectedFile.path === f.path
              }
              onOpen={() =>
                openFile({
                  path: f.path,
                  oldPath: f.oldPath,
                  source: "commit",
                  hash: commit.hash,
                  status: f.status,
                })
              }
            />
          ))
        )}
      </div>
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
