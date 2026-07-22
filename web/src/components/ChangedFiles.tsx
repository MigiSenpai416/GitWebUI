import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import type { CommitFile } from "../types";
import { FileRow } from "./FileRow";
import { buildTree, allDirPaths, type TreeNode } from "./fileTree";
import { IconChevron, IconChevronDown, IconFolder, IconPath, IconTree } from "./icons";
import "./ChangedFiles.css";

interface Props {
  files: CommitFile[];
  loading: boolean;
  isActive: (f: CommitFile) => boolean;
  onOpen: (f: CommitFile) => void;
}

/**
 * The "N files changed" header and the path/tree list under it. A stash is a
 * commit, so both details panes show their contents exactly the same way; the
 * path/tree choice is shared app state, and only the collapsed folders are
 * local to the panel that's open.
 */
export function ChangedFiles({ files, loading, isActive, onOpen }: Props) {
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

  return (
    <>
      <div className="cf-head">
        <span className="cf-count">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <div className="layout-toggle cf-layout-toggle">
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
      <div className="cf-list">
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
            <FileList
              files={files}
              layout={fileLayout}
              collapsedDirs={collapsedDirs}
              toggleDir={toggleDir}
              isActive={isActive}
              onOpen={onOpen}
            />
          </>
        )}
      </div>
    </>
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

function FileList({ files, layout, collapsedDirs, toggleDir, isActive, onOpen }: FileListProps) {
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
        <TreeRows
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

function TreeRows({
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
          <TreeRows
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
