import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import { buildTree, type TreeNode } from "./fileTree";
import {
  IconChevron,
  IconChevronDown,
  IconCheck,
  IconFolder,
  IconPath,
  IconTree,
  IconWarning,
} from "./icons";
import "./ConflictPanel.css";

type PathLeaf = { path: string };

/**
 * Replaces the changes panel while a merge/rebase/revert is in progress. Lists
 * the still-conflicted files (click one to open the resolver) and the files
 * already resolved this session, with a one-click "Mark All Resolved" and an
 * escape hatch to abort the whole operation.
 */
export function ConflictPanel() {
  const merge = useStore((s) => s.mergeState);
  const seen = useStore((s) => s.mergeSeen);
  const conflictPath = useStore((s) => s.conflictPath);
  const openConflict = useStore((s) => s.openConflict);
  const markAllResolved = useStore((s) => s.markAllResolved);
  const abortMerge = useStore((s) => s.abortMerge);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const fileLayout = useStore((s) => s.fileLayout);
  const setFileLayout = useStore((s) => s.setFileLayout);

  const [conflictedOpen, setConflictedOpen] = useState(true);
  const [resolvedOpen, setResolvedOpen] = useState(true);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const conflicted = merge?.conflicted ?? [];
  const resolved = useMemo(
    () => seen.filter((p) => !conflicted.includes(p)),
    [seen, conflicted],
  );

  const toggleDir = (path: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const onAbort = async () => {
    const verb = merge?.kind ?? "merge";
    const ok = await requestConfirm(
      `Abort the ${verb} and restore the state from before it started? Any resolutions will be discarded.`,
      "Abort",
    );
    if (ok) abortMerge();
  };

  return (
    <div className="conflict-panel">
      <div className="cp-topbar">
        <IconWarning width={16} height={16} className="cp-warn" />
        <span className="cp-title">Merge conflicts detected</span>
        <button className="cp-abort" onClick={onAbort} title="Abort and restore the previous state">
          Abort
        </button>
      </div>

      <div className="cp-controls">
        <div className="layout-toggle">
          <button className={fileLayout === "path" ? "active" : ""} onClick={() => setFileLayout("path")}>
            <IconPath width={14} height={14} /> Path
          </button>
          <button className={fileLayout === "tree" ? "active" : ""} onClick={() => setFileLayout("tree")}>
            <IconTree width={14} height={14} /> Tree
          </button>
        </div>
      </div>

      <div className="cp-scroll">
        <Section
          title="Conflicted Files"
          count={conflicted.length}
          open={conflictedOpen}
          onToggle={() => setConflictedOpen((v) => !v)}
          action={
            conflicted.length > 0
              ? { label: "Mark All Resolved", onClick: markAllResolved }
              : undefined
          }
        >
          <FileList
            paths={conflicted}
            layout={fileLayout}
            variant="conflict"
            activePath={conflictPath}
            collapsedDirs={collapsedDirs}
            toggleDir={toggleDir}
            onOpen={openConflict}
            emptyText="No conflicts remaining — commit to finish."
          />
        </Section>

        <Section
          title="Resolved Files"
          count={resolved.length}
          open={resolvedOpen}
          onToggle={() => setResolvedOpen((v) => !v)}
        >
          <FileList
            paths={resolved}
            layout={fileLayout}
            variant="resolved"
            activePath={null}
            collapsedDirs={collapsedDirs}
            toggleDir={toggleDir}
            emptyText="Nothing resolved yet"
          />
        </Section>
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}

function Section({ title, count, open, onToggle, action, children }: SectionProps) {
  return (
    <section className="cp-section">
      <div className="cp-section-head">
        <button className="cp-section-toggle" onClick={onToggle}>
          {open ? <IconChevronDown /> : <IconChevron />}
          <span className="cp-section-title">{title}</span>
          <span className="cp-section-num">({count})</span>
        </button>
        {action && (
          <button
            className="cp-mark-all"
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      {open && children}
    </section>
  );
}

interface FileListProps {
  paths: string[];
  layout: "path" | "tree";
  variant: "conflict" | "resolved";
  activePath: string | null;
  collapsedDirs: Set<string>;
  toggleDir: (path: string) => void;
  onOpen?: (path: string) => void;
  emptyText: string;
}

function FileList({
  paths,
  layout,
  variant,
  activePath,
  collapsedDirs,
  toggleDir,
  onOpen,
  emptyText,
}: FileListProps) {
  const leaves = useMemo<PathLeaf[]>(() => paths.map((p) => ({ path: p })), [paths]);
  const tree = useMemo(() => (layout === "tree" ? buildTree(leaves) : []), [leaves, layout]);

  if (paths.length === 0) {
    return <div className="cp-empty">{emptyText}</div>;
  }
  if (layout === "path") {
    return (
      <>
        {paths.map((p) => (
          <FileRow
            key={p}
            path={p}
            name={p}
            depth={0}
            variant={variant}
            activePath={activePath}
            onOpen={onOpen}
          />
        ))}
      </>
    );
  }
  return (
    <>
      {tree.map((node) => (
        <TreeRows
          key={node.path}
          node={node}
          depth={0}
          variant={variant}
          activePath={activePath}
          collapsedDirs={collapsedDirs}
          toggleDir={toggleDir}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

interface RowShared {
  variant: "conflict" | "resolved";
  activePath: string | null;
  onOpen?: (path: string) => void;
}

function TreeRows({
  node,
  depth,
  collapsedDirs,
  toggleDir,
  ...shared
}: {
  node: TreeNode<PathLeaf>;
  depth: number;
  collapsedDirs: Set<string>;
  toggleDir: (path: string) => void;
} & RowShared) {
  if (node.type === "file") {
    return <FileRow path={node.file.path} name={node.name} depth={depth} {...shared} />;
  }
  const collapsed = collapsedDirs.has(node.path);
  return (
    <>
      <button
        className="cp-dir"
        style={{ paddingLeft: 12 + depth * 15 }}
        onClick={() => toggleDir(node.path)}
      >
        {collapsed ? <IconChevron /> : <IconChevronDown />}
        <IconFolder width={15} height={15} className="cp-dir-icon" />
        <span className="cp-dir-name">{node.name}</span>
      </button>
      {!collapsed &&
        node.children.map((child) => (
          <TreeRows
            key={child.path}
            node={child}
            depth={depth + 1}
            collapsedDirs={collapsedDirs}
            toggleDir={toggleDir}
            {...shared}
          />
        ))}
    </>
  );
}

function FileRow({
  path,
  name,
  depth,
  variant,
  activePath,
  onOpen,
}: { path: string; name: string; depth: number } & RowShared) {
  const clickable = variant === "conflict" && !!onOpen;
  return (
    <button
      className={
        "cp-file " + variant + (activePath === path ? " active" : "") + (clickable ? " clickable" : "")
      }
      style={{ paddingLeft: 12 + depth * 15 }}
      onClick={clickable ? () => onOpen!(path) : undefined}
      disabled={!clickable}
      title={path}
    >
      {variant === "conflict" ? (
        <IconWarning width={14} height={14} className="cp-file-icon warn" />
      ) : (
        <IconCheck width={14} height={14} className="cp-file-icon ok" />
      )}
      <span className="cp-file-name">{name}</span>
    </button>
  );
}
