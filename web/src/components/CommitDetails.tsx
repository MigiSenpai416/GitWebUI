import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import type { CommitFile } from "../types";
import { FileRow } from "./FileRow";
import { buildTree, allDirPaths, type TreeNode } from "./fileTree";
import { IconChevron, IconChevronDown, IconFolder, IconPath, IconTree } from "./icons";
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
  const fileLayout = useStore((s) => s.fileLayout);
  const setFileLayout = useStore((s) => s.setFileLayout);

  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const toggleDir = (path: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  const collapseAll = () => setCollapsedDirs(new Set(allDirPaths(buildTree(files))));

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
          ✕
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

      <div className="cd-files-head">
        <span className="cd-files-count">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <div className="layout-toggle cd-layout-toggle">
          <button
            className={fileLayout === "path" ? "active" : ""}
            onClick={() => setFileLayout("path")}
          >
            <IconPath width={13} height={13} /> Path
          </button>
          <button
            className={fileLayout === "tree" ? "active" : ""}
            onClick={() => setFileLayout("tree")}
          >
            <IconTree width={13} height={13} /> Tree
          </button>
        </div>
      </div>
      <div className="cd-files">
        {loading ? (
          <div className="section-empty">Loading…</div>
        ) : files.length === 0 ? (
          <div className="section-empty">No file changes</div>
        ) : (
          <>
            {fileLayout === "tree" && (
              <button className="collapse-all" onClick={collapseAll}>
                Collapse All
              </button>
            )}
            <CommitFileList
              files={files}
              layout={fileLayout}
              collapsedDirs={collapsedDirs}
              toggleDir={toggleDir}
              isActive={isActive}
              onOpen={open}
            />
          </>
        )}
      </div>
    </div>
  );
}

interface FileListProps {
  files: CommitFile[];
  layout: "path" | "tree";
  collapsedDirs: Set<string>;
  toggleDir: (path: string) => void;
  isActive: (f: CommitFile) => boolean;
  onOpen: (f: CommitFile) => void;
}

function CommitFileList({ files, layout, collapsedDirs, toggleDir, isActive, onOpen }: FileListProps) {
  const tree = useMemo(() => (layout === "tree" ? buildTree(files) : []), [files, layout]);

  if (layout === "path") {
    return (
      <>
        {files.map((f) => (
          <FileRow key={f.path} file={f} active={isActive(f)} showDir onOpen={() => onOpen(f)} />
        ))}
      </>
    );
  }

  return (
    <>
      {tree.map((node) => (
        <CommitTreeRows
          key={node.path}
          node={node}
          depth={0}
          collapsedDirs={collapsedDirs}
          toggleDir={toggleDir}
          isActive={isActive}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

function CommitTreeRows({
  node,
  depth,
  collapsedDirs,
  toggleDir,
  isActive,
  onOpen,
}: {
  node: TreeNode<CommitFile>;
  depth: number;
} & Omit<FileListProps, "files" | "layout">) {
  if (node.type === "file") {
    return (
      <FileRow
        file={node.file}
        active={isActive(node.file)}
        depth={depth}
        showDir={false}
        onOpen={() => onOpen(node.file)}
      />
    );
  }
  const collapsed = collapsedDirs.has(node.path);
  return (
    <>
      <button
        className="tree-dir"
        style={{ paddingLeft: 12 + depth * 15 }}
        onClick={() => toggleDir(node.path)}
      >
        {collapsed ? <IconChevron /> : <IconChevronDown />}
        <IconFolder width={15} height={15} className="tree-folder-icon" />
        <span className="tree-dir-name">{node.name}</span>
      </button>
      {!collapsed &&
        node.children.map((child) => (
          <CommitTreeRows
            key={child.path}
            node={child}
            depth={depth + 1}
            collapsedDirs={collapsedDirs}
            toggleDir={toggleDir}
            isActive={isActive}
            onOpen={onOpen}
          />
        ))}
    </>
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
