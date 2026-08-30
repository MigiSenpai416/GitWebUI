import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore, type GraphMode } from "../state/store";
import type { Commit, StashEntry } from "../types";
import { RefBadges } from "./RefBadges";
import { IconWarning } from "./icons";
import {
  graphLaneX,
  graphSvgWidth,
  layoutCommitGraph,
  type CommitGraphRow,
  type GraphSegment,
} from "./commitGraph";
import "./CommitList.css";

const ROW = 28;
const GRAPH_COLUMN_WIDTH = 96;
/** Refs, a usable message area, author, and hash beside a wide graph. */
const WIDE_GRAPH_REMAINING_WIDTH = 502;
const GRAPH_COLORS = [
  "var(--graph-color)",
  "var(--amber)",
  "var(--purple)",
  "var(--green)",
  "var(--accent)",
  "var(--red)",
  "#db61a2",
  "#6cb6ff",
];

export function CommitList() {
  const commits = useStore((s) => s.commits);
  const hasMore = useStore((s) => s.hasMore);
  const loadingCommits = useStore((s) => s.loadingCommits);
  const selectedCommitHash = useStore((s) => s.selectedCommitHash);
  const selectCommit = useStore((s) => s.selectCommit);
  const loadCommits = useStore((s) => s.loadCommits);
  const openCommitMenu = useStore((s) => s.openCommitMenu);
  const status = useStore((s) => s.status);
  const stashes = useStore((s) => s.stashes);
  const selectedStashHash = useStore((s) => s.selectedStashHash);
  const selectStash = useStore((s) => s.selectStash);
  const openStashMenu = useStore((s) => s.openStashMenu);
  const branch = useStore((s) => s.repo?.branch ?? "");
  const mergeState = useStore((s) => s.mergeState);
  const graphMode = useStore((s) => s.graphMode);
  const setGraphMode = useStore((s) => s.setGraphMode);

  const parentRef = useRef<HTMLDivElement>(null);
  const wipCount = status.staged.length + status.unstaged.length;
  const fullGraph = useMemo(
    () => graphMode === "full" ? layoutCommitGraph(commits) : null,
    [commits, graphMode],
  );
  const graphWidth = fullGraph ? graphSvgWidth(fullGraph.maxLanes) : 34;
  const graphColumnWidth = fullGraph
    ? Math.max(GRAPH_COLUMN_WIDTH, graphWidth + 8)
    : GRAPH_COLUMN_WIDTH;
  const graphColumnStyle = { width: graphColumnWidth };
  const graphContentStyle = fullGraph && graphColumnWidth > GRAPH_COLUMN_WIDTH
    ? { minWidth: graphColumnWidth + WIDE_GRAPH_REMAINING_WIDTH }
    : undefined;

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
      <div className="commit-list-inner" style={graphContentStyle}>
        <div className="commit-list-header">
          <div className="col-refs-head">Branch / Tag</div>
          <div className="col-graph-head" style={graphColumnStyle}>
            <button
              type="button"
              className={"graph-mode-toggle" + (graphMode === "full" ? " active" : "")}
              aria-pressed={graphMode === "full"}
              title={graphMode === "full" ? "Show linear commit history" : "Show full commit graph"}
              onClick={() => setGraphMode(graphMode === "full" ? "linear" : "full")}
            >
              <span>Graph</span>
              <span className="graph-mode-value">{graphMode === "full" ? "Full" : "Linear"}</span>
            </button>
          </div>
          <div className="col-msg-head">Commit Message</div>
        </div>

        {mergeState?.active && (
          <div className="merge-banner" role="status">
            <IconWarning width={15} height={15} />
            <span>{mergeState.message}</span>
          </div>
        )}

        {wipCount > 0 && (
          <button
            className={
              "clrow wip-row" + (selectedCommitHash === null && !selectedStashHash ? " selected" : "")
            }
            onClick={() => selectCommit(null)}
          >
            <span className="col-refs" />
            <span className="col-graph" style={graphColumnStyle}>
              <svg width={graphWidth} height={ROW} className="graph-svg">
                {graphMode === "linear" && (
                  <line x1="17" y1={ROW / 2} x2="17" y2={ROW} className="graph-line" />
                )}
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

        {stashes.map((st) => (
          <StashRow
            key={st.hash}
            stash={st}
            branch={branch}
            graphMode={graphMode}
            graphWidth={graphWidth}
            graphColumnStyle={graphColumnStyle}
            selected={st.hash === selectedStashHash}
            onSelect={() => selectStash(st.hash)}
            onMenu={(x, y) => {
              selectStash(st.hash);
              openStashMenu({ index: st.index, x, y });
            }}
          />
        ))}

        <div className="commit-scroll" ref={parentRef}>
          <div className="commit-vlist" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((vi) => {
              const commit = commits[vi.index];
              return (
                <CommitRow
                  key={commit.hash}
                  commit={commit}
                  graphMode={graphMode}
                  graphRow={fullGraph?.rows[vi.index]}
                  graphWidth={graphWidth}
                  graphColumnStyle={graphColumnStyle}
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
    </div>
  );
}

interface RowProps {
  commit: Commit;
  graphMode: GraphMode;
  graphRow?: CommitGraphRow;
  graphWidth: number;
  graphColumnStyle: React.CSSProperties;
  first: boolean;
  last: boolean;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  style: React.CSSProperties;
}

function CommitRow({
  commit,
  graphMode,
  graphRow,
  graphWidth,
  graphColumnStyle,
  first,
  last,
  selected,
  onSelect,
  onContextMenu,
  style,
}: RowProps) {
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
      <span className="col-graph" style={graphColumnStyle}>
        {graphMode === "full" && graphRow ? (
          <FullGraphRow commit={commit} row={graphRow} width={graphWidth} />
        ) : (
          <svg width="34" height={ROW} className="graph-svg" aria-hidden="true">
            <line
              x1="17"
              y1={first ? ROW / 2 : 0}
              x2="17"
              y2={last ? ROW / 2 : ROW}
              className="graph-line"
            />
            <circle cx="17" cy={ROW / 2} r="5.5" className="graph-node" />
          </svg>
        )}
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

function FullGraphRow({ commit, row, width }: { commit: Commit; row: CommitGraphRow; width: number }) {
  return (
    <svg width={width} height={ROW} className="graph-svg full-graph-svg" aria-hidden="true">
      {row.segments.map((segment, index) => (
        <path
          key={`${segment.kind}-${index}`}
          d={segmentPath(segment)}
          className="full-graph-edge"
          stroke={graphColor(segment.color)}
          data-edge={segment.kind}
          data-parent-hash={segment.parentHash}
          data-from-lane={segment.fromLane}
          data-to-lane={segment.toLane}
        />
      ))}
      <circle
        cx={graphLaneX(row.nodeLane)}
        cy={ROW / 2}
        r="5.5"
        className="graph-node full-graph-node"
        stroke={graphColor(row.nodeColor)}
        data-commit-hash={commit.hash}
        data-node-lane={row.nodeLane}
      />
    </svg>
  );
}

function segmentPath(segment: GraphSegment): string {
  const x1 = graphLaneX(segment.fromLane);
  const x2 = graphLaneX(segment.toLane);
  const y1 = segment.fromPosition * ROW;
  const y2 = segment.toPosition * ROW;
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const bend = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${bend}, ${x2} ${bend}, ${x2} ${y2}`;
}

function graphColor(color: number): string {
  return GRAPH_COLORS[color % GRAPH_COLORS.length];
}

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.replace(/\s+/g, " ").trim();
}

function StashRow({
  stash,
  branch,
  graphMode,
  graphWidth,
  graphColumnStyle,
  selected,
  onSelect,
  onMenu,
}: {
  stash: StashEntry;
  branch: string;
  graphMode: GraphMode;
  graphWidth: number;
  graphColumnStyle: React.CSSProperties;
  selected: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      className={"clrow stash-row" + (selected ? " selected" : "")}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={stash.noteBody || "Stash — click to open, right-click for pop / apply / drop"}
    >
      <span className="col-refs" />
      <span className="col-graph" style={graphColumnStyle}>
        <svg width={graphWidth} height={ROW} className="graph-svg">
          {graphMode === "linear" && (
            <line x1="17" y1="0" x2="17" y2={ROW} className="graph-line stash-line" />
          )}
          <rect x="11" y={ROW / 2 - 6} width="12" height="12" rx="2.5" className="graph-node-stash" />
        </svg>
      </span>
      <span className="col-msg">
        <span className="stash-title">{stashTitle(stash, branch)}</span>
        {stash.noteBody && <span className="msg-body">{firstLine(stash.noteBody)}</span>}
      </span>
    </div>
  );
}

/**
 * What the user named the stash, else the GitKraken-style "WIP #<n> in <branch>"
 * — git's own label says the same thing for every stash on a branch.
 */
function stashTitle(stash: StashEntry, fallbackBranch: string): string {
  if (stash.noteTitle) return stash.noteTitle;
  const m = stash.message.match(/^(?:WIP on|On) ([^:]+):/);
  const branch = m ? m[1] : fallbackBranch;
  return `WIP #${stash.index} in ${branch}`;
}
