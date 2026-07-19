import type { CommitRef } from "../types";
import { IconCheck, IconMonitor } from "./icons";
import "./RefBadge.css";

export function RefBadge({ refInfo }: { refInfo: CommitRef }) {
  if (refInfo.kind === "head" && refInfo.name === "HEAD") {
    // Bare detached HEAD marker; skip to avoid noise when a branch also points here.
    return null;
  }
  const cls = `ref-badge ref-${refInfo.kind}` + (refInfo.isHead ? " ref-current" : "");
  return (
    <span className={cls} title={refInfo.name}>
      {refInfo.isHead && (
        <span className="ref-check">
          <IconCheck />
        </span>
      )}
      {refInfo.kind === "tag" && <span className="ref-icon">🏷</span>}
      <span className="ref-name">{refInfo.name}</span>
      {refInfo.kind === "branch" && (
        <span className="ref-monitor">
          <IconMonitor />
        </span>
      )}
    </span>
  );
}
