import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../state/store";
import type { Commit } from "../types";
import { RefBadges } from "./RefBadges";
import "./CommitList.css";

const ROW = 28;

export function CommitList() {
  const commits = useStore((s) => s.commits);
  const hasMore = useStore((s) => s.hasMore);
  const loadingCommits = useStore((s) => s.loadingCommits);
  const selectedCommitHash = useStore((s) => s.selectedCommitHash);
  const selectCommit = useStore((s) => s.selectCommit);
  const loadCommits = useStore((s) => s.loadCommits);
  const openCommitMenu = useStore((s) => s.openCommitMenu);
  const status = useStore((s) => s.status);

  const parentRef = useRef<HTMLDivElement>(null);
  const wipCount = status.staged.length + status.unstaged.length;

  const rowCount = commits.length;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW,
    overscan: 14,
  });

  const items = virtualizer.getVirtualItems();
  const lastItem = items[items.length - 1];
  useEffect(() => {
    if (!lastItem) return;
    if (hasMore && !loadingCommits && lastItem.index >= rowCount - 25) {
      loadCommits(false);
    }
  }, [lastItem, hasMore, loadingCommits, rowCount, loadCommits]);

  return (
    <div className="commit-list">
      <div className="commit-list-header">
        <div className="col-refs-head">Branch / Tag</div>
        <div className="col-graph-head">Graph</div>
        <div className="col-msg-head">Commit Message</div>
      </div>

      {wipCount > 0 && (
        <button
          className={"clrow wip-row" + (selectedCommitHash === null ? " selected" : "")}
          onClick={() => selectCommit(null)}
        >
          <span className="col-refs" />
          <span className="col-graph">
            <svg width="34" height={ROW} className="graph-svg">
              <line x1="17" y1={ROW / 2} x2="17" y2={ROW} className="graph-line" />
              <circle cx="17" cy={ROW / 2} r="6" className="graph-node wip" />
            </svg>
          </span>
          <span className="col-msg">
            <span className="wip-title">// WIP</span>
            <span className="wip-badges">
              <span className="wip-pill unstaged">✎ {status.unstaged.length}</span>
              <span className="wip-pill staged">+ {status.staged.length}</span>
            </span>
          </span>
        </button>
      )}

      <div className="commit-scroll" ref={parentRef}>
        <div className="commit-vlist" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((vi) => {
            const commit = commits[vi.index];
            return (
              <CommitRow
                key={commit.hash}
                commit={commit}
                first={vi.index === 0 && wipCount === 0}
                last={vi.index === rowCount - 1 && !hasMore}
                selected={commit.hash === selectedCommitHash}
                onSelect={() => selectCommit(commit.hash)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  selectCommit(commit.hash);
                  openCommitMenu({ hash: commit.hash, x: e.clientX, y: e.clientY });
                }}
                style={{ transform: `translateY(${vi.start}px)` }}
              />
            );
          })}
        </div>
        {loadingCommits && <div className="commit-loading">Loading…</div>}
      </div>
    </div>
  );
}

interface RowProps {
  commit: Commit;
  first: boolean;
  last: boolean;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  style: React.CSSProperties;
}

function CommitRow({ commit, first, last, selected, onSelect, onContextMenu, style }: RowProps) {
  return (
    <div
      className={"clrow commit-row" + (selected ? " selected" : "")}
      style={style}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <span className="col-refs">
        <RefBadges refs={commit.refs} />
      </span>
      <span className="col-graph">
        <svg width="34" height={ROW} className="graph-svg">
          <line x1="17" y1={first ? ROW / 2 : 0} x2="17" y2={last ? ROW / 2 : ROW} className="graph-line" />
          <circle cx="17" cy={ROW / 2} r="5.5" className="graph-node" />
        </svg>
      </span>
      <span className="col-msg">
        <span className="msg-subject">{commit.subject}</span>
        {commit.body && <span className="msg-body">{firstLine(commit.body)}</span>}
      </span>
      <span className="col-author" title={`${commit.author} <${commit.email}>`}>
        {commit.author}
      </span>
      <span className="col-hash">{commit.shortHash}</span>
    </div>
  );
}

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.replace(/\s+/g, " ").trim();
}
