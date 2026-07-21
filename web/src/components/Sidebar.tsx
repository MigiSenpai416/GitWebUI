import { useEffect, useMemo, useRef, useState } from "react";
import { localRef, useStore } from "../state/store";
import type { Branch, RemoteBranch, Worktree } from "../types";
import { buildTree, type TreeNode } from "./fileTree";
import {
  IconBranch,
  IconChevron,
  IconChevronDown,
  IconClipboard,
  IconExternal,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconHome,
  IconMonitor,
  IconPlus as IconPlusGlyph,
  IconRefresh,
  IconTrash,
  IconWorktree,
} from "./icons";
import "./Sidebar.css";

/**
 * Left rail listing the repo's LOCAL branches and REMOTE targets. Branches can
 * be checked out; the REMOTE header reveals a green + to add a remote.
 */
export function Sidebar() {
  const branches = useStore((s) => s.branches);
  const remotes = useStore((s) => s.remotes);
  const remoteBranches = useStore((s) => s.remoteBranches);
  const visibleRefs = useStore((s) => s.visibleRefs);
  const toggleBranchVisibility = useStore((s) => s.toggleBranchVisibility);
  const repo = useStore((s) => s.repo);
  const checkout = useStore((s) => s.checkout);
  const checkoutRemote = useStore((s) => s.checkoutRemote);
  const openAddRemote = useStore((s) => s.openAddRemote);
  const removeRemote = useStore((s) => s.removeRemote);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  const worktrees = useStore((s) => s.worktrees);
  const loadWorktrees = useStore((s) => s.loadWorktrees);
  const openWorktreeCreate = useStore((s) => s.openWorktreeCreate);
  const openWorktree = useStore((s) => s.openWorktree);
  const removeWorktree = useStore((s) => s.removeWorktree);
  const pruneWorktrees = useStore((s) => s.pruneWorktrees);
  const revealWorktree = useStore((s) => s.revealWorktree);
  const setNotice = useStore((s) => s.setNotice);

  const [localOpen, setLocalOpen] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState(true);
  const [worktreeOpen, setWorktreeOpen] = useState(true);
  const [wtMenu, setWtMenu] = useState<{ wt: Worktree; x: number; y: number } | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const toggleDir = (key: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Group remote branches by their remote (e.g. "origin"), preserving the
  // remotes list order and appending any remote seen only in branch refs.
  const remoteNames = useMemo(() => {
    const names = remotes.map((r) => r.name);
    for (const b of remoteBranches) if (!names.includes(b.remote)) names.push(b.remote);
    return names;
  }, [remotes, remoteBranches]);
  const visibleSet = useMemo(() => new Set(visibleRefs), [visibleRefs]);

  const onRemoveRemote = async (name: string) => {
    const ok = await requestConfirm(
      `This is a destructive operation, are you sure you want to remove the remote "${name}"?`,
      "Remove",
    );
    if (ok) removeRemote(name);
  };

  const onRemoveWorktree = async (wt: Worktree) => {
    const label = wt.branch ?? wt.path;
    const branchNote = wt.branch ? ` and its branch "${wt.branch}"` : "";
    const ok = await requestConfirm(
      `Remove the worktree "${label}"${branchNote}? Its working directory will be deleted.`,
      "Remove",
    );
    if (ok) removeWorktree(wt.path);
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setNotice("Copied the worktree path.");
    } catch {
      setNotice("Couldn't access the clipboard.");
    }
  };

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button className="sb-toggle" title="Show sidebar" onClick={toggleSidebar}>
          <IconPanelRight />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sb-topbar">
        <button className="sb-toggle" title="Hide sidebar" onClick={toggleSidebar}>
          <IconPanelLeft />
        </button>
      </div>
      <Section
        icon={<IconMonitor width={15} height={15} />}
        label="Local"
        count={branches.length}
        open={localOpen}
        onToggle={() => setLocalOpen((v) => !v)}
      >
        {branches.length === 0 ? (
          <div className="sb-empty">No branches</div>
        ) : (
          branches.map((b) => (
            <BranchRow
              key={b.name}
              branch={b}
              visible={visibleSet.has(localRef(b.name))}
              onCheckout={() => checkout(b.name)}
              onToggleVisible={() => toggleBranchVisibility(localRef(b.name))}
            />
          ))
        )}
      </Section>

      <Section
        icon={<IconCloud />}
        label="Remote"
        count={remoteBranches.length}
        open={remoteOpen}
        onToggle={() => setRemoteOpen((v) => !v)}
        actions={[
          {
            title: "Add remote",
            icon: <IconPlusGlyph width={15} height={15} />,
            onClick: openAddRemote,
            tone: "green",
          },
        ]}
      >
        {remoteNames.length === 0 ? (
          <div className="sb-empty">No remotes — add one to push</div>
        ) : (
          remoteNames.map((name) => {
            const remote = remotes.find((r) => r.name === name);
            const branches = remoteBranches.filter((b) => b.remote === name);
            return (
              <RemoteGroup
                key={name}
                name={name}
                url={remote?.url}
                branches={branches}
                visibleSet={visibleSet}
                collapsedDirs={collapsedDirs}
                toggleDir={toggleDir}
                onToggleVisible={toggleBranchVisibility}
                onCheckout={(b) => checkoutRemote(b.name, b.shortName)}
                onRemove={remote ? () => onRemoveRemote(name) : undefined}
              />
            );
          })
        )}
      </Section>

      <Section
        icon={<IconWorktree width={15} height={15} />}
        label="Worktrees"
        count={worktrees.length}
        open={worktreeOpen}
        onToggle={() => setWorktreeOpen((v) => !v)}
        actions={[
          { title: "Refresh WIP", icon: <IconRefresh width={14} height={14} />, onClick: loadWorktrees },
          {
            title: "Create worktree",
            icon: <IconPlusGlyph width={15} height={15} />,
            onClick: openWorktreeCreate,
            tone: "green",
          },
        ]}
      >
        {worktrees.length === 0 ? (
          <div className="sb-empty">No worktrees</div>
        ) : (
          worktrees.map((wt) => (
            <WorktreeRow
              key={wt.path}
              wt={wt}
              onOpen={() => openWorktree(wt.path)}
              onMenu={(e) => {
                e.preventDefault();
                setWtMenu({ wt, x: e.clientX, y: e.clientY });
              }}
            />
          ))
        )}
      </Section>

      {repo && <div className="sb-repo" title={repo.root}>{repo.root}</div>}

      {wtMenu && (
        <WorktreeMenu
          menu={wtMenu}
          onClose={() => setWtMenu(null)}
          onOpen={() => openWorktree(wtMenu.wt.path)}
          onRemove={() => onRemoveWorktree(wtMenu.wt)}
          onReveal={() => revealWorktree(wtMenu.wt.path)}
          onCopy={() => copyPath(wtMenu.wt.path)}
          onPrune={pruneWorktrees}
        />
      )}
    </aside>
  );
}

interface SectionAction {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  /** "green" for creative actions (default is a neutral tint). */
  tone?: "green";
}

interface SectionProps {
  icon: React.ReactNode;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  actions?: SectionAction[];
  children: React.ReactNode;
}

function Section({ icon, label, count, open, onToggle, actions, children }: SectionProps) {
  const hasActions = !!actions && actions.length > 0;
  return (
    <section className={"sb-section" + (hasActions ? " has-action" : "")}>
      <div className="sb-head">
        <button className="sb-head-btn" onClick={onToggle}>
          {open ? <IconChevronDown width={13} height={13} /> : <IconChevron width={13} height={13} />}
          <span className="sb-head-icon">{icon}</span>
          <span className="sb-head-label">{label}</span>
          <span className="sb-head-count">{count}</span>
        </button>
        {hasActions && (
          <div className="sb-actions">
            {actions!.map((a) => (
              <button
                key={a.title}
                className={"sb-add" + (a.tone === "green" ? " green" : "")}
                title={a.title}
                onClick={(e) => {
                  e.stopPropagation();
                  a.onClick();
                }}
              >
                {a.icon}
              </button>
            ))}
          </div>
        )}
      </div>
      {open && <div className="sb-list">{children}</div>}
    </section>
  );
}

interface BranchRowProps {
  branch: Branch;
  visible: boolean;
  onCheckout: () => void;
  onToggleVisible: () => void;
}

/**
 * A local branch: click the name to check it out; toggle the eye to show or hide
 * the branch's commits in the graph (so you can, e.g., cherry-pick from it). The
 * current branch's commits are always shown, so it carries a check, not an eye.
 */
function BranchRow({ branch, visible, onCheckout, onToggleVisible }: BranchRowProps) {
  const current = branch.current;
  return (
    <div
      className={
        "sb-item sb-branch-local" +
        (current ? " current" : "") +
        (visible && !current ? " visible" : "")
      }
    >
      {current ? (
        <span className="sb-check sb-branch-slot">✓</span>
      ) : (
        <button
          className="sb-eye sb-branch-slot"
          title={visible ? "Hide this branch's commits" : "Show this branch's commits in the graph"}
          onClick={onToggleVisible}
        >
          {visible ? <IconEye width={15} height={15} /> : <IconEyeOff width={15} height={15} />}
        </button>
      )}
      <button
        className="sb-branch-checkout"
        onClick={onCheckout}
        title={branch.upstream ? `tracks ${branch.upstream}` : `Check out ${branch.name}`}
      >
        <IconBranch width={14} height={14} className="sb-item-icon" />
        <span className="sb-item-name">{branch.name}</span>
      </button>
    </div>
  );
}

interface RemoteGroupProps {
  name: string;
  url?: string;
  branches: RemoteBranch[];
  visibleSet: Set<string>;
  collapsedDirs: Set<string>;
  toggleDir: (key: string) => void;
  onToggleVisible: (ref: string) => void;
  onCheckout: (branch: RemoteBranch) => void;
  onRemove?: () => void;
}

/** One remote (e.g. "origin") and its branches, grouped into a folder tree. */
function RemoteGroup({
  name,
  url,
  branches,
  visibleSet,
  collapsedDirs,
  toggleDir,
  onToggleVisible,
  onCheckout,
  onRemove,
}: RemoteGroupProps) {
  const tree = useMemo(
    () => buildTree(branches.map((b) => ({ path: b.shortName, branch: b }))),
    [branches],
  );
  return (
    <>
      <div className="sb-item sb-remote" title={url ?? name}>
        <IconCloud />
        <span className="sb-item-name">{name}</span>
        {url && <span className="sb-remote-url">{shortenUrl(url)}</span>}
        {onRemove && (
          <button
            className="sb-remote-remove"
            title="Remove remote"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <IconTrash width={13} height={13} />
          </button>
        )}
      </div>
      {tree.map((node) => (
        <RemoteTreeRows
          key={node.path}
          node={node}
          keyPrefix={name}
          depth={1}
          visibleSet={visibleSet}
          collapsedDirs={collapsedDirs}
          toggleDir={toggleDir}
          onToggleVisible={onToggleVisible}
          onCheckout={onCheckout}
        />
      ))}
    </>
  );
}

type BranchLeaf = { path: string; branch: RemoteBranch };

interface TreeRowsProps {
  node: TreeNode<BranchLeaf>;
  keyPrefix: string;
  depth: number;
  visibleSet: Set<string>;
  collapsedDirs: Set<string>;
  toggleDir: (key: string) => void;
  onToggleVisible: (ref: string) => void;
  onCheckout: (branch: RemoteBranch) => void;
}

function RemoteTreeRows({
  node,
  keyPrefix,
  depth,
  visibleSet,
  collapsedDirs,
  toggleDir,
  onToggleVisible,
  onCheckout,
}: TreeRowsProps) {
  if (node.type === "file") {
    const b = node.file.branch;
    return (
      <RemoteBranchLeaf
        branch={b}
        label={node.name}
        depth={depth}
        visible={visibleSet.has(b.ref)}
        onToggleVisible={onToggleVisible}
        onCheckout={onCheckout}
      />
    );
  }
  const key = keyPrefix + "::" + node.path;
  const collapsed = collapsedDirs.has(key);
  return (
    <>
      <button
        className="sb-item sb-dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => toggleDir(key)}
      >
        {collapsed ? <IconChevron width={12} height={12} /> : <IconChevronDown width={12} height={12} />}
        <IconFolder width={14} height={14} className="sb-item-icon" />
        <span className="sb-item-name">{node.name}</span>
      </button>
      {!collapsed &&
        node.children.map((child) => (
          <RemoteTreeRows
            key={child.path}
            node={child}
            keyPrefix={keyPrefix}
            depth={depth + 1}
            visibleSet={visibleSet}
            collapsedDirs={collapsedDirs}
            toggleDir={toggleDir}
            onToggleVisible={onToggleVisible}
            onCheckout={onCheckout}
          />
        ))}
    </>
  );
}

interface RemoteBranchLeafProps {
  branch: RemoteBranch;
  label: string;
  depth: number;
  visible: boolean;
  onToggleVisible: (ref: string) => void;
  onCheckout: (branch: RemoteBranch) => void;
}

/**
 * A remote-tracking branch leaf. A single click does nothing; toggling the eye
 * shows/hides the branch's commits in the graph, and a double click checks it
 * out as a local tracking branch (like GitKraken).
 */
function RemoteBranchLeaf({
  branch,
  label,
  depth,
  visible,
  onToggleVisible,
  onCheckout,
}: RemoteBranchLeafProps) {
  return (
    <div
      className={"sb-item sb-branch" + (visible ? " visible" : "")}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={`${branch.name} — double-click to check out; toggle the eye to ${visible ? "hide" : "show"} its commits`}
      onDoubleClick={() => onCheckout(branch)}
    >
      <button
        className="sb-eye"
        title={visible ? "Hide branch commits" : "Show branch commits"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisible(branch.ref);
        }}
      >
        {visible ? <IconEye width={15} height={15} /> : <IconEyeOff width={15} height={15} />}
      </button>
      <IconBranch width={13} height={13} className="sb-item-icon" />
      <span className="sb-item-name">{label}</span>
    </div>
  );
}

/** Trim a git URL to owner/repo for compact display. */
function shortenUrl(url: string): string {
  const m = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : url;
}

function IconCloud() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 11.2 3.8 3.8 0 0 0 7 19h10.5Z" />
    </svg>
  );
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** One worktree row: double-click opens it; right-click reveals its actions. */
function WorktreeRow({
  wt,
  onOpen,
  onMenu,
}: {
  wt: Worktree;
  onOpen: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const label = wt.branch ?? (wt.detached && wt.head ? wt.head.slice(0, 7) : basename(wt.path));
  return (
    <div
      className={"sb-item sb-worktree" + (wt.current ? " current" : "")}
      title={`${wt.path}\nDouble-click to open`}
      onDoubleClick={onOpen}
      onContextMenu={onMenu}
    >
      {wt.isMain ? (
        <IconHome width={14} height={14} className="sb-item-icon" />
      ) : (
        <IconWorktree width={14} height={14} className="sb-item-icon" />
      )}
      <span className="sb-item-name">{label}</span>
      {wt.locked && <span className="sb-wt-lock" title="Locked">🔒</span>}
    </div>
  );
}

/** Right-click actions for a worktree. */
function WorktreeMenu({
  menu,
  onClose,
  onOpen,
  onRemove,
  onReveal,
  onCopy,
  onPrune,
}: {
  menu: { wt: Worktree; x: number; y: number };
  onClose: () => void;
  onOpen: () => void;
  onRemove: () => void;
  onReveal: () => void;
  onCopy: () => void;
  onPrune: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Defer so the opening right-click doesn't immediately dismiss the menu.
    const id = window.setTimeout(() => document.addEventListener("mousedown", close), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const removable = !menu.wt.isMain && !menu.wt.current;
  const run = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <div
      ref={ref}
      className="wt-menu"
      style={{ top: menu.y, left: menu.x }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className="wt-menu-item" onClick={() => run(onOpen)}>
        <IconExternal width={14} height={14} /> Open
      </button>
      <button className="wt-menu-item" onClick={() => run(onReveal)}>
        <IconFolder width={14} height={14} /> Open folder in file explorer
      </button>
      <button className="wt-menu-item" onClick={() => run(onCopy)}>
        <IconClipboard width={14} height={14} /> Copy path
      </button>
      <div className="wt-menu-sep" />
      <button
        className="wt-menu-item danger"
        disabled={!removable}
        title={removable ? undefined : "The main and current worktrees can't be removed"}
        onClick={() => removable && run(onRemove)}
      >
        <IconTrash width={14} height={14} /> Remove worktree
      </button>
      <button className="wt-menu-item" onClick={() => run(onPrune)}>
        <IconRefresh width={14} height={14} /> Prune stale worktrees
      </button>
    </div>
  );
}

/** Panel-collapse glyph (a rail + a chevron), pointing the way it will move. */
function IconPanelLeft() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M10 4v16" />
      <path d="m16.5 9-2.5 3 2.5 3" />
    </svg>
  );
}
function IconPanelRight() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M10 4v16" />
      <path d="m13.5 9 2.5 3-2.5 3" />
    </svg>
  );
}
