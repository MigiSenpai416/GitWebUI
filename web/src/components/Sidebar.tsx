import { useState } from "react";
import { useStore } from "../state/store";
import type { Branch, Remote } from "../types";
import { IconBranch, IconChevron, IconChevronDown, IconMonitor, IconTrash } from "./icons";
import "./Sidebar.css";

/**
 * Left rail listing the repo's LOCAL branches and REMOTE targets. Branches can
 * be checked out; the REMOTE header reveals a green + to add a remote.
 */
export function Sidebar() {
  const branches = useStore((s) => s.branches);
  const remotes = useStore((s) => s.remotes);
  const repo = useStore((s) => s.repo);
  const checkout = useStore((s) => s.checkout);
  const openAddRemote = useStore((s) => s.openAddRemote);
  const removeRemote = useStore((s) => s.removeRemote);
  const requestConfirm = useStore((s) => s.requestConfirm);

  const [localOpen, setLocalOpen] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState(true);

  const onRemoveRemote = async (name: string) => {
    const ok = await requestConfirm(
      `This is a destructive operation, are you sure you want to remove the remote "${name}"?`,
      "Remove",
    );
    if (ok) removeRemote(name);
  };

  return (
    <aside className="sidebar">
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
        count={remotes.length}
        open={remoteOpen}
        onToggle={() => setRemoteOpen((v) => !v)}
        action={{ title: "Add remote", onClick: openAddRemote }}
      >
        {remotes.length === 0 ? (
          <div className="sb-empty">No remotes — add one to push</div>
        ) : (
          remotes.map((r) => (
            <RemoteRow key={r.name} remote={r} onRemove={() => onRemoveRemote(r.name)} />
          ))
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

function RemoteRow({ remote, onRemove }: { remote: Remote; onRemove: () => void }) {
  return (
    <div className="sb-item sb-remote" title={remote.url}>
      <IconCloud />
      <span className="sb-item-name">{remote.name}</span>
      <span className="sb-remote-url">{shortenUrl(remote.url)}</span>
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

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
