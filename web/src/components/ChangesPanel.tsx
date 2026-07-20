import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import type { FileChange } from "../types";
import { FileRow } from "./FileRow";
import { buildTree, allDirPaths, type TreeNode } from "./fileTree";
import { IconChevron, IconChevronDown, IconFolder, IconPath, IconSort, IconSparkle, IconTrash, IconTree } from "./icons";
import "./ChangesPanel.css";

export function ChangesPanel() {
  const repo = useStore((s) => s.repo);
  const status = useStore((s) => s.status);
  const stage = useStore((s) => s.stage);
  const stageAll = useStore((s) => s.stageAll);
  const unstage = useStore((s) => s.unstage);
  const discardAll = useStore((s) => s.discardAll);
  const openFile = useStore((s) => s.openFile);
  const selectedFile = useStore((s) => s.selectedFile);
  const fileLayout = useStore((s) => s.fileLayout);
  const setFileLayout = useStore((s) => s.setFileLayout);
  const setNotice = useStore((s) => s.setNotice);
  const requestConfirm = useStore((s) => s.requestConfirm);

  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const total = status.staged.length + status.unstaged.length;

  const open = (f: FileChange) =>
    openFile({
      path: f.path,
      oldPath: f.oldPath,
      source: f.staged ? "staged" : "unstaged",
      staged: f.staged,
      status: f.status,
    });

  const isActive = (f: FileChange) =>
    selectedFile != null &&
    selectedFile.source !== "commit" &&
    selectedFile.path === f.path &&
    selectedFile.staged === f.staged;

  const collapseAll = () => {
    const all = [
      ...allDirPaths(buildTree(status.unstaged)),
      ...allDirPaths(buildTree(status.staged)),
    ];
    setCollapsedDirs(new Set(all));
  };
  const toggleDir = (path: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const doDiscard = async () => {
    if (total === 0) return;
    const ok = await requestConfirm(
      `This is a destructive operation, are you sure you want to discard all ${total} change${total === 1 ? "" : "s"}?`,
      "Discard",
    );
    if (ok) discardAll();
  };

  return (
    <div className="changes-panel">
      <div className="changes-topbar">
        <button
          className="trash-btn"
          title="Discard all changes"
          onClick={doDiscard}
          disabled={total === 0}
        >
          <IconTrash width={16} height={16} />
        </button>
        <div className="changes-title">
          {total} file change{total === 1 ? "" : "s"} on <span className="changes-branch">{repo?.branch}</span>
        </div>
        <button className="ai-btn" title="AI features (coming soon)" onClick={() => setNotice("AI features aren't available yet.")}>
          <IconSparkle width={16} height={16} />
        </button>
      </div>

      <div className="changes-controls">
        <button className="sort-btn" title="Sort" onClick={() => setNotice("Sorting options are coming soon.")}>
          <IconSort width={16} height={16} />
        </button>
        <div className="layout-toggle">
          <button className={fileLayout === "path" ? "active" : ""} onClick={() => setFileLayout("path")}>
            <IconPath width={14} height={14} /> Path
          </button>
          <button className={fileLayout === "tree" ? "active" : ""} onClick={() => setFileLayout("tree")}>
            <IconTree width={14} height={14} /> Tree
          </button>
        </div>
      </div>

      <div className="changes-scroll">
        <Section
          title="Unstaged Files"
          count={status.unstaged.length}
          open={unstagedOpen}
          onToggle={() => setUnstagedOpen((v) => !v)}
          action={
            status.unstaged.length > 0 ? { label: "Stage All Changes", onClick: () => stageAll() } : undefined
          }
        >
          {fileLayout === "tree" && status.unstaged.length > 0 && (
            <button className="collapse-all" onClick={collapseAll}>
              Collapse All
            </button>
          )}
          <FileList
            files={status.unstaged}
            layout={fileLayout}
            collapsedDirs={collapsedDirs}
            toggleDir={toggleDir}
            isActive={isActive}
            onOpen={open}
            actionLabel="Stage"
            onAction={(f) => stage([f.path])}
            emptyText="No unstaged changes"
          />
        </Section>

        <Section
          title="Staged Files"
          count={status.staged.length}
          open={stagedOpen}
          onToggle={() => setStagedOpen((v) => !v)}
          action={
            status.staged.length > 0
              ? { label: "Unstage All", onClick: () => unstage(status.staged.map((f) => f.path)) }
              : undefined
          }
        >
          <FileList
            files={status.staged}
            layout={fileLayout}
            collapsedDirs={collapsedDirs}
            toggleDir={toggleDir}
            isActive={isActive}
            onOpen={open}
            actionLabel="Unstage"
            onAction={(f) => unstage([f.path])}
            emptyText="No staged changes"
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
    <section className="changes-section">
      <div className="section-head">
        <button className="section-toggle" onClick={onToggle}>
          {open ? <IconChevronDown /> : <IconChevron />}
          <span className="section-title">{title}</span>
          <span className="section-num">({count})</span>
        </button>
        {action && (
          <button
            className="stage-all-btn"
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
  files: FileChange[];
  layout: "path" | "tree";
  collapsedDirs: Set<string>;
  toggleDir: (path: string) => void;
  isActive: (f: FileChange) => boolean;
  onOpen: (f: FileChange) => void;
  actionLabel: string;
  onAction: (f: FileChange) => void;
  emptyText: string;
}

function FileList(props: FileListProps) {
  const { files, layout, emptyText } = props;
  const tree = useMemo(() => (layout === "tree" ? buildTree(files) : []), [files, layout]);

  if (files.length === 0) {
    return <div className="section-empty">{emptyText}</div>;
  }

  if (layout === "path") {
    return (
      <>
        {files.map((f) => (
          <FileRow
            key={f.path}
            file={f}
            active={props.isActive(f)}
            showDir
            actionLabel={props.actionLabel}
            onAction={() => props.onAction(f)}
            onOpen={() => props.onOpen(f)}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {tree.map((node) => (
        <TreeRows key={node.path} node={node} depth={0} {...props} />
      ))}
    </>
  );
}

function TreeRows({
  node,
  depth,
  collapsedDirs,
  toggleDir,
  isActive,
  onOpen,
  actionLabel,
  onAction,
}: { node: TreeNode; depth: number } & Omit<FileListProps, "files" | "layout" | "emptyText">) {
  if (node.type === "file") {
    return (
      <FileRow
        file={node.file}
        active={isActive(node.file)}
        depth={depth}
        showDir={false}
        actionLabel={actionLabel}
        onAction={() => onAction(node.file)}
        onOpen={() => onOpen(node.file)}
      />
    );
  }
  const collapsed = collapsedDirs.has(node.path);
  return (
    <>
      <button className="tree-dir" style={{ paddingLeft: 12 + depth * 15 }} onClick={() => toggleDir(node.path)}>
        {collapsed ? <IconChevron /> : <IconChevronDown />}
        <IconFolder width={15} height={15} className="tree-folder-icon" />
        <span className="tree-dir-name">{node.name}</span>
      </button>
      {!collapsed &&
        node.children.map((child) => (
          <TreeRows
            key={child.path}
            node={child}
            depth={depth + 1}
            collapsedDirs={collapsedDirs}
            toggleDir={toggleDir}
            isActive={isActive}
            onOpen={onOpen}
            actionLabel={actionLabel}
            onAction={onAction}
          />
        ))}
    </>
  );
}
