import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import type { Branch, RemoteBranch } from "../types";
import { buildTree, type TreeNode } from "./fileTree";
import {
  IconBranch,
  IconChevron,
  IconChevronDown,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconMonitor,
  IconTrash,
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
  const openAddRemote = useStore((s) => s.openAddRemote);
  const removeRemote = useStore((s) => s.removeRemote);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  const [localOpen, setLocalOpen] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState(true);
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
            <BranchRow key={b.name} branch={b} onCheckout={() => checkout(b.name)} />
          ))
        )}
      </Section>

      <Section
        icon={<IconCloud />}
        label="Remote"
        count={remoteBranches.length}
        open={remoteOpen}
        onToggle={() => setRemoteOpen((v) => !v)}
        action={{ title: "Add remote", onClick: openAddRemote }}
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
                onRemove={remote ? () => onRemoveRemote(name) : undefined}
              />
            );
          })
        )}
      </Section>

      {repo && <div className="sb-repo" title={repo.root}>{repo.root}</div>}
    </aside>
  );
}

interface SectionProps {
  icon: React.ReactNode;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action?: { title: string; onClick: () => void };
  children: React.ReactNode;
}

function Section({ icon, label, count, open, onToggle, action, children }: SectionProps) {
  return (
    <section className={"sb-section" + (action ? " has-action" : "")}>
      <div className="sb-head">
        <button className="sb-head-btn" onClick={onToggle}>
          {open ? <IconChevronDown width={13} height={13} /> : <IconChevron width={13} height={13} />}
          <span className="sb-head-icon">{icon}</span>
          <span className="sb-head-label">{label}</span>
          <span className="sb-head-count">{count}</span>
        </button>
        {action && (
          <button
            className="sb-add"
            title={action.title}
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
            }}
          >
            <IconPlus />
          </button>
        )}
      </div>
      {open && <div className="sb-list">{children}</div>}
    </section>
  );
}

function BranchRow({ branch, onCheckout }: { branch: Branch; onCheckout: () => void }) {
  return (
    <button
      className={"sb-item" + (branch.current ? " current" : "")}
      onClick={onCheckout}
      title={branch.upstream ? `tracks ${branch.upstream}` : branch.name}
    >
      {branch.current ? (
        <span className="sb-check">✓</span>
      ) : (
        <IconBranch width={14} height={14} className="sb-item-icon" />
      )}
      <span className="sb-item-name">{branch.name}</span>
    </button>
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
        />
      ))}
    </>
  );
}

type BranchLeaf = { path: string; branch: RemoteBranch };

function RemoteTreeRows({
  node,
  keyPrefix,
  depth,
  visibleSet,
  collapsedDirs,
  toggleDir,
  onToggleVisible,
}: {
  node: TreeNode<BranchLeaf>;
  keyPrefix: string;
  depth: number;
  visibleSet: Set<string>;
  collapsedDirs: Set<string>;
  toggleDir: (key: string) => void;
  onToggleVisible: (ref: string) => void;
}) {
  if (node.type === "file") {
    const b = node.file.branch;
    const visible = visibleSet.has(b.ref);
    return (
      <div
        className={"sb-item sb-branch" + (visible ? " visible" : "")}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={`${b.name} — ${visible ? "hide" : "show"} its commits`}
        onClick={() => onToggleVisible(b.ref)}
      >
        <button
          className="sb-eye"
          title={visible ? "Hide branch commits" : "Show branch commits"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisible(b.ref);
          }}
        >
          {visible ? <IconEye width={15} height={15} /> : <IconEyeOff width={15} height={15} />}
        </button>
        <IconBranch width={13} height={13} className="sb-item-icon" />
        <span className="sb-item-name">{node.name}</span>
      </div>
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
          />
        ))}
    </>
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

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
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
