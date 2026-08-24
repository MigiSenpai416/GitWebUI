import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../api/client";
import { writeClipboard } from "../desktop";
import { useStore } from "../state/store";
import type { HeadEntryKind, HeadFileEntry, HistoryDeleteResult } from "../types";
import {
  IconChevron,
  IconChevronDown,
  IconFolder,
  IconRefresh,
  IconSearch,
  IconSpinner,
  IconTrash,
} from "./icons";
import "./FileManager.css";

type BrowserKind = "directory" | HeadEntryKind;

interface BrowserNode {
  name: string;
  path: string;
  kind: BrowserKind;
  mode: string;
  size: number | null;
  fileCount: number;
  children: BrowserNode[];
}

interface MenuState {
  node: BrowserNode;
  x: number;
  y: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function FileManager({ open, onClose }: Props) {
  const repo = useStore((s) => s.repo);
  const refreshAll = useStore((s) => s.refreshAll);
  const setNotice = useStore((s) => s.setNotice);
  const [head, setHead] = useState<string | null>(null);
  const [entries, setEntries] = useState<HeadFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BrowserNode | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [lastResult, setLastResult] = useState<HistoryDeleteResult | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuInvoker = useRef<HTMLElement | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLElement>(null);
  const loadGeneration = useRef(0);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const root = useMemo(() => buildTree(entries), [entries]);
  const current = useMemo(() => findNode(root, currentPath) ?? root, [root, currentPath]);
  const selected = useMemo(
    () => (selectedPath == null ? null : findNode(root, selectedPath)),
    [root, selectedPath],
  );
  const searchResult = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return { nodes: sorted(current.children), total: current.children.length };
    const matches = flatten(root)
      .filter((node) => node.path.toLocaleLowerCase().includes(needle))
      .sort(compareNodes);
    return { nodes: matches.slice(0, 500), total: matches.length };
  }, [current, query, root]);
  const shown = searchResult.nodes;
  const rowVirtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => rowsRef.current,
    estimateSize: () => 30,
    overscan: 18,
  });

  const dismissMenu = useCallback((restore = true) => {
    setMenu(null);
    const invoker = menuInvoker.current;
    menuInvoker.current = null;
    if (restore && invoker) queueMicrotask(() => invoker.focus());
  }, []);

  const closeConfirmation = useCallback(() => {
    const invoker = menuInvoker.current;
    menuInvoker.current = null;
    setPendingDelete(null);
    setConfirmation("");
    window.setTimeout(() => {
      if (invoker?.isConnected) invoker.focus();
      else dialogRef.current?.focus();
    }, 0);
  }, []);

  const load = async () => {
    if (!repo) return;
    const requestRoot = repo.root;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError("");
    try {
      const tree = await api.historyFiles();
      if (
        generation !== loadGeneration.current ||
        useStore.getState().repo?.root !== requestRoot ||
        useStore.getState().opening
      ) return;
      setHead(tree.head);
      setEntries(tree.entries);
      const paths = new Set(tree.entries.map((entry) => entry.path));
      const dirs = directoryPaths(tree.entries);
      if (currentPath && !dirs.has(currentPath)) setCurrentPath("");
      if (selectedPath && !paths.has(selectedPath) && !dirs.has(selectedPath)) setSelectedPath(null);
    } catch (cause) {
      if (generation === loadGeneration.current && useStore.getState().repo?.root === requestRoot) {
        setError(messageOf(cause));
      }
    } finally {
      if (generation === loadGeneration.current && useStore.getState().repo?.root === requestRoot) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHead(null);
    setEntries([]);
    setCurrentPath("");
    setSelectedPath(null);
    setQuery("");
    setExpanded(new Set([""]));
    setMenu(null);
    menuInvoker.current = null;
    setPendingDelete(null);
    setConfirmation("");
    setLastResult(null);
    setError("");
    void load();
    // The repository root identifies the API binding; other local view state
    // intentionally survives refreshes while this repository stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo?.root]);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => dialogRef.current?.focus());
      return;
    }
    loadGeneration.current += 1;
    restoreFocus.current?.focus();
    restoreFocus.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleting) return;
      if (pendingDelete) {
        closeConfirmation();
      } else if (menu) {
        dismissMenu();
      } else {
        onClose();
      }
    };
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const scope = pendingDelete ? confirmRef.current : dialogRef.current;
      if (!scope) return;
      const focusable = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        scope.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", trapFocus);
    };
  }, [closeConfirmation, deleting, dismissMenu, menu, onClose, open, pendingDelete]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) dismissMenu();
    };
    document.addEventListener("mousedown", close);
    queueMicrotask(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    return () => document.removeEventListener("mousedown", close);
  }, [dismissMenu, menu]);

  if (!open || !repo) return null;

  const navigate = (node: BrowserNode) => {
    if (node.kind !== "directory") return;
    setCurrentPath(node.path);
    setSelectedPath(node.path);
    setQuery("");
    setExpanded((before) => withAncestors(before, node.path));
  };

  const openMenu = (event: React.MouseEvent, node: BrowserNode) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPath(node.path);
    const currentTarget = event.currentTarget as HTMLElement;
    menuInvoker.current =
      (event.target as HTMLElement).closest<HTMLElement>("button") ??
      currentTarget.querySelector<HTMLElement>(".fm-tree-name") ??
      currentTarget;
    const rect = currentTarget.getBoundingClientRect();
    const requestedX = event.clientX || rect.left + 20;
    const requestedY = event.clientY || rect.top + Math.min(rect.height, 24);
    setMenu({
      node,
      x: Math.min(requestedX, window.innerWidth - 286),
      y: Math.min(requestedY, window.innerHeight - 154),
    });
  };

  const copy = async (value: string, label: string) => {
    dismissMenu();
    try {
      await writeClipboard(value);
      setNotice(label);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const beginDelete = () => {
    if (!menu) return;
    setPendingDelete(menu.node);
    setMenu(null);
    setConfirmation("");
    setError("");
  };

  const performDelete = async () => {
    if (!pendingDelete || !head || confirmation !== pendingDelete.path) return;
    const requestRoot = repo.root;
    const targetPath = pendingDelete.path;
    setDeleting(true);
    setError("");
    try {
      const result = await api.deleteFromHistory(targetPath, head, confirmation);
      if (useStore.getState().repo?.root !== requestRoot) {
        setNotice(`Removed ${result.path} from ${basename(requestRoot)} history.`);
        return;
      }
      setLastResult(result);
      setPendingDelete(null);
      menuInvoker.current = null;
      setConfirmation("");
      setCurrentPath("");
      setSelectedPath(null);
      setNotice(`Removed ${result.path} from reachable Git history.`);
      window.setTimeout(() => dialogRef.current?.focus(), 0);
      await refreshAll();
      await load();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDeleting(false);
    }
  };

  const crumbs = currentPath ? currentPath.split("/") : [];
  const repoName = basename(repo.root);

  return (
    <div className="fm-overlay" onMouseDown={(e) => e.target === e.currentTarget && !deleting && onClose()}>
      <section className="fm-window" ref={dialogRef} role="dialog" aria-modal="true" aria-label="File Manager" tabIndex={-1}>
        <header className="fm-header">
          <div className="fm-title-icon"><IconFolder /></div>
          <div className="fm-heading">
            <strong>File Manager</strong>
            <span>{repoName} · files tracked at HEAD {head ? head.slice(0, 8) : "(unborn)"}</span>
          </div>
          <button className="fm-close" onClick={onClose} disabled={deleting} aria-label="Close">×</button>
        </header>

        <div className="fm-commandbar">
          <button
            className="fm-command"
            onClick={() => navigate(parentNode(root, currentPath))}
            disabled={!currentPath}
            title="Up one folder"
          >
            ↑
          </button>
          <div className="fm-breadcrumb" aria-label="Current folder">
            <button onClick={() => navigate(root)}>{repoName}</button>
            {crumbs.map((part, index) => {
              const path = crumbs.slice(0, index + 1).join("/");
              return (
                <span key={path}>
                  <IconChevron />
                  <button onClick={() => navigate(findNode(root, path) ?? root)}>{part}</button>
                </span>
              );
            })}
          </div>
          <label className="fm-search">
            <IconSearch />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tracked files"
              aria-label="Search tracked files"
            />
          </label>
          <button className="fm-command" onClick={() => void load()} disabled={loading} title="Refresh HEAD files">
            {loading ? <IconSpinner /> : <IconRefresh />}
          </button>
        </div>

        {error && !pendingDelete && <div className="fm-error" role="alert">{error}</div>}
        {lastResult && (
          <div className="fm-result">
            <span>
              Removed <code>{lastResult.path}</code> from {lastResult.rewrittenRefs} rewritten ref{lastResult.rewrittenRefs === 1 ? "" : "s"}.
              {lastResult.warnings.length > 0 && ` ${lastResult.warnings.join(" ")}`}
            </span>
            <button onClick={() => void copy(lastResult.backupPath, "Copied recovery-bundle path.")}>Copy recovery path</button>
            <button onClick={() => void copy(lastResult.worktreeBackupPath, "Copied working-tree backup path.")}>Copy working-tree backup path</button>
            <button onClick={() => void copy(lastResult.indexBackupPath, "Copied pre-rewrite index path.")}>Copy index backup path</button>
          </div>
        )}

        <div className="fm-body">
          <aside className="fm-tree" aria-label="Repository folders">
            <TreeRow
              node={root}
              label={repoName}
              depth={0}
              currentPath={current.path}
              expanded={expanded}
              setExpanded={setExpanded}
              navigate={navigate}
              onContextMenu={openMenu}
            />
          </aside>

          <main className="fm-list" onContextMenu={(e) => e.preventDefault()}>
            <div className="fm-columns">
              <span>Name</span>
              <span>Type</span>
              <span>Size</span>
            </div>
            <div className="fm-rows" ref={rowsRef}>
              {loading && entries.length === 0 ? (
                <div className="fm-empty"><IconSpinner /> Loading HEAD…</div>
              ) : shown.length === 0 ? (
                <div className="fm-empty">{query ? "No matching tracked files" : "This folder is empty in HEAD"}</div>
              ) : (
                <div className="fm-rows-inner" style={{ height: rowVirtualizer.getTotalSize() }}>
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const node = shown[virtualRow.index];
                    return (
                      <button
                        className={`fm-row${selected?.path === node.path ? " selected" : ""}`}
                        key={`${node.kind}:${node.path}`}
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                        onClick={() => setSelectedPath(node.path)}
                        onDoubleClick={() => navigate(node)}
                        onContextMenu={(event) => openMenu(event, node)}
                        title={node.path}
                      >
                        <span className={`fm-name fm-${node.kind}`}>
                          {node.kind === "directory" ? <IconFolder /> : <FileGlyph kind={node.kind} />}
                          <span>{node.name}</span>
                        </span>
                        <span>{typeLabel(node.kind)}</span>
                        <span>{node.kind === "directory" ? `${node.fileCount} items` : formatSize(node.size)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <footer className="fm-status">
              <span>{entries.length} tracked {entries.length === 1 ? "entry" : "entries"}</span>
              <span>
                {query && searchResult.total > shown.length
                  ? `Showing first ${shown.length} of ${searchResult.total} matches — refine the search`
                  : selected
                    ? selected.path || repoName
                    : "Right-click a file or folder for actions"}
              </span>
            </footer>
          </main>
        </div>

        {menu && (
          <div
            className="fm-context"
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${menu.node.path}`}
            style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(event) => handleMenuKey(event, menuRef.current, dismissMenu)}
          >
            {menu.node.kind === "directory" && (
              <button role="menuitem" onClick={() => { navigate(menu.node); dismissMenu(); }}>
                <IconFolder /> Open folder
              </button>
            )}
            <button role="menuitem" onClick={() => void copy(menu.node.path, "Copied repository path.")}>⧉ Copy repository path</button>
            <button role="menuitem" onClick={() => void copy(joinPath(repo.root, menu.node.path), "Copied absolute path.")}>⧉ Copy absolute path</button>
            <div />
            <button role="menuitem" className="danger" onClick={beginDelete}>
              <IconTrash /> Delete {menu.node.kind === "directory" ? "directory" : "file"} from history…
            </button>
            <small>{menu.node.path}</small>
          </div>
        )}

        {pendingDelete && (
          <div className="fm-confirm-shade">
            <section className="fm-confirm" ref={confirmRef} role="alertdialog" aria-modal="true" aria-label="Confirm history rewrite" tabIndex={-1}>
              <div className="fm-confirm-title"><IconTrash /> Permanently rewrite Git history?</div>
              <p>
                This removes the exact path <code>{pendingDelete.path}</code>
                {pendingDelete.kind === "directory" ? " and everything beneath it" : ""} from every reachable local ref.
              </p>
              <ul>
                <li>All local branches, tags, remote-tracking refs, and stashes are rewritten.</li>
                <li>Commit IDs change; published refs will require a coordinated force-push.</li>
                <li>Remote repositories and other clones are not changed automatically.</li>
                <li>Earlier names from renames are not inferred; only this exact path is removed.</li>
                <li>Cryptographic signatures on rewritten commits and tags will no longer be valid.</li>
                <li>Non-stash reflogs are cleared, so their ordinary undo/recovery names, messages, timestamps, and ordering are lost.</li>
                <li>A recovery bundle containing the original history is saved outside the repository before any ref moves.</li>
                <li>The removed working-tree content and exact pre-rewrite index are also retained under the repository's Git directory.</li>
                <li>After verification, delete all three recovery artifacts separately if the path contains sensitive data.</li>
                <li>Unreachable old Git objects may remain until pruning; for a sensitive-data purge, verify a fresh clone and then securely remove the old repository and every recovery artifact.</li>
              </ul>
              {error && <div className="fm-confirm-error" role="alert">{error}</div>}
              <label>
                Type the exact repository path to confirm:
                <input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder={pendingDelete.path}
                  autoFocus
                  disabled={deleting}
                  spellCheck={false}
                />
              </label>
              <div className="fm-confirm-actions">
                <button
                  className="fm-cancel"
                  onClick={closeConfirmation}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  className="fm-delete"
                  onClick={() => void performDelete()}
                  disabled={deleting || !head || confirmation !== pendingDelete.path}
                >
                  {deleting ? <><IconSpinner /> Rewriting history…</> : <><IconTrash /> Delete from all history</>}
                </button>
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

interface TreeRowProps {
  node: BrowserNode;
  label: string;
  depth: number;
  currentPath: string;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  navigate: (node: BrowserNode) => void;
  onContextMenu: (event: React.MouseEvent, node: BrowserNode) => void;
}

function TreeRow(props: TreeRowProps) {
  const { node, label, depth, currentPath, expanded, setExpanded, navigate, onContextMenu } = props;
  const dirs = sorted(node.children.filter((child) => child.kind === "directory"));
  const isOpen = expanded.has(node.path);
  return (
    <>
      <div
        className={`fm-tree-row${currentPath === node.path ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onContextMenu={(event) => node.path && onContextMenu(event, node)}
      >
        <button
          className="fm-tree-toggle"
          onClick={() => setExpanded((before) => toggleSet(before, node.path))}
          aria-label={isOpen ? "Collapse folder" : "Expand folder"}
        >
          {dirs.length > 0 ? (isOpen ? <IconChevronDown /> : <IconChevron />) : <span />}
        </button>
        <button className="fm-tree-name" onClick={() => navigate(node)} title={node.path || label}>
          <IconFolder /> <span>{label}</span>
        </button>
      </div>
      {isOpen && dirs.map((dir) => (
        <TreeRow
          {...props}
          key={dir.path}
          node={dir}
          label={dir.name}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

function buildTree(entries: HeadFileEntry[]): BrowserNode {
  const root: BrowserNode = { name: "", path: "", kind: "directory", mode: "040000", size: null, fileCount: 0, children: [] };
  const dirs = new Map<string, BrowserNode>([["", root]]);
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let parent = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const dirPath = parts.slice(0, index + 1).join("/");
      let dir = dirs.get(dirPath);
      if (!dir) {
        dir = { name: parts[index], path: dirPath, kind: "directory", mode: "040000", size: null, fileCount: 0, children: [] };
        dirs.set(dirPath, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    parent.children.push({
      name: parts[parts.length - 1],
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      size: entry.size,
      fileCount: 1,
      children: [],
    });
  }
  const directories = [...dirs.values()].sort(
    (a, b) => b.path.split("/").length - a.path.split("/").length,
  );
  for (const dir of directories) {
    dir.fileCount = dir.children.reduce((total, child) => total + child.fileCount, 0);
  }
  return root;
}

function findNode(root: BrowserNode, want: string): BrowserNode | null {
  if (root.path === want) return root;
  for (const child of root.children) {
    const found = findNode(child, want);
    if (found) return found;
  }
  return null;
}

function parentNode(root: BrowserNode, currentPath: string): BrowserNode {
  const parts = currentPath.split("/").filter(Boolean);
  parts.pop();
  return findNode(root, parts.join("/")) ?? root;
}

function flatten(root: BrowserNode): BrowserNode[] {
  const result: BrowserNode[] = [];
  const stack = [...root.children].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    result.push(node);
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]);
  }
  return result;
}

function sorted(nodes: BrowserNode[]): BrowserNode[] {
  return [...nodes].sort(compareNodes);
}

function compareNodes(a: BrowserNode, b: BrowserNode): number {
  if (a.kind === "directory" && b.kind !== "directory") return -1;
  if (a.kind !== "directory" && b.kind === "directory") return 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function toggleSet(before: Set<string>, path: string): Set<string> {
  const next = new Set(before);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

function withAncestors(before: Set<string>, path: string): Set<string> {
  const next = new Set(before);
  next.add("");
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
  return next;
}

function directoryPaths(entries: HeadFileEntry[]): Set<string> {
  const dirs = new Set<string>([""]);
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return dirs;
}

function formatSize(size: number | null): string {
  if (size == null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function typeLabel(kind: BrowserKind): string {
  if (kind === "directory") return "Folder";
  if (kind === "symlink") return "Symbolic link";
  if (kind === "submodule") return "Git submodule";
  return "File";
}

function FileGlyph({ kind }: { kind: HeadEntryKind }) {
  return <span className="fm-file-glyph">{kind === "symlink" ? "↗" : kind === "submodule" ? "◇" : ""}</span>;
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function joinPath(root: string, relative: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + separator + relative.replace(/\//g, separator);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function handleMenuKey(
  event: React.KeyboardEvent,
  menu: HTMLElement | null,
  dismiss: (restore?: boolean) => void,
): void {
  if (!menu) return;
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  if (!items.length) return;
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
  let next = -1;
  if (event.key === "ArrowDown") next = (current + 1) % items.length;
  else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    dismiss();
    return;
  }
  if (next >= 0) {
    event.preventDefault();
    items[next].focus();
  }
}
