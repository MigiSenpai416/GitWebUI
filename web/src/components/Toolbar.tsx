import { useState } from "react";
import { useStore } from "../state/store";
import { BranchMenu } from "./BranchMenu";
import { ActionsMenu } from "./ActionsMenu";
import {
  IconActions,
  IconBranch,
  IconCaretDown,
  IconPop,
  IconPull,
  IconPush,
  IconRedo,
  IconSearch,
  IconSpinner,
  IconStash,
  IconTerminal,
  IconUndo,
} from "./icons";
import "./Toolbar.css";

export function Toolbar() {
  const repo = useStore((s) => s.repo);
  const setNotice = useStore((s) => s.setNotice);
  const logout = useStore((s) => s.logout);
  const push = useStore((s) => s.push);
  const pull = useStore((s) => s.pull);
  const remoteBusy = useStore((s) => s.remoteBusy);
  const busyAction = useStore((s) => s.busyAction);
  const stash = useStore((s) => s.stash);
  const stashPop = useStore((s) => s.stashPop);
  const stashes = useStore((s) => s.stashes);
  const selectedStashHash = useStore((s) => s.selectedStashHash);
  const status = useStore((s) => s.status);
  const [branchOpen, setBranchOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  if (!repo) return null;

  const hasChanges = status.staged.length + status.unstaged.length > 0;

  // Pop takes the stash you have open, so a stash can be picked out of the
  // graph and popped from here; with none open it stays on the latest.
  const popTarget = stashes.find((s) => s.hash === selectedStashHash);
  const popTitle = !stashes.length
    ? "No stashes"
    : popTarget
      ? `Apply and remove ${popTarget.noteTitle || popTarget.ref}`
      : "Apply the latest stash";

  const soon = (label: string) => () => setNotice(`${label} isn't available yet — remote & history actions are coming later.`);

  return (
    <div className="toolbar">
      <div className="tb-left">
        <div className="tb-branch">
          <span className="tb-branch-label">branch</span>
          <button
            className="tb-branch-btn"
            onClick={() => setBranchOpen((v) => !v)}
            title="Switch branch"
          >
            <span className="tb-branch-name">{repo.branch}</span>
            <IconCaretDown className="tb-branch-caret" />
          </button>
          {branchOpen && <BranchMenu onClose={() => setBranchOpen(false)} />}
        </div>
      </div>

      <div className="tb-center">
        <div className="tb-group">
          <ToolButton label="Undo" onClick={soon("Undo")}>
            <IconUndo />
          </ToolButton>
          <ToolButton label="Redo" onClick={soon("Redo")}>
            <IconRedo />
          </ToolButton>
        </div>

        <div className="tb-divider" />

        <div className="tb-group">
          <ToolButton
            label="Pull"
            onClick={() => pull()}
            disabled={remoteBusy}
            busy={busyAction === "pull"}
          >
            <IconPull />
          </ToolButton>
          <ToolButton
            label="Push"
            onClick={() => push()}
            disabled={remoteBusy}
            busy={busyAction === "push"}
          >
            <IconPush />
          </ToolButton>
          <ToolButton label="Branch" onClick={() => setBranchOpen((v) => !v)}>
            <IconBranch />
          </ToolButton>
          <ToolButton
            label="Stash"
            onClick={() => stash()}
            disabled={remoteBusy || !hasChanges}
            busy={busyAction === "stash"}
            title={hasChanges ? "Stash all changes" : "No changes to stash"}
          >
            <IconStash />
          </ToolButton>
          <ToolButton
            label="Pop"
            onClick={() => stashPop(popTarget?.index ?? 0)}
            disabled={remoteBusy || stashes.length === 0}
            busy={busyAction === "pop"}
            badge={stashes.length || undefined}
            title={popTitle}
          >
            <IconPop />
          </ToolButton>
        </div>

        <div className="tb-divider" />

        <div className="tb-group">
          <ToolButton label="Terminal" onClick={soon("Terminal")}>
            <IconTerminal />
          </ToolButton>
        </div>
      </div>

      <div className="tb-right">
        <div className="tb-menu-anchor">
          <ToolButton label="Actions" onClick={() => setActionsOpen((v) => !v)}>
            <IconActions />
          </ToolButton>
          {actionsOpen && <ActionsMenu onClose={() => setActionsOpen(false)} />}
        </div>
        <ToolButton label="Search" onClick={soon("Search")}>
          <IconSearch />
        </ToolButton>
        <ToolButton label="Lock" onClick={() => logout()}>
          <IconLock />
        </ToolButton>
      </div>
    </div>
  );
}

function IconLock() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

interface ToolButtonProps {
  label: string;
  caret?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  /** This button's action is running — its icon becomes a spinner. */
  busy?: boolean;
  title?: string;
  /** Small count bubble shown on the icon (e.g. stash count on Pop). */
  badge?: number;
  children: React.ReactNode;
}

function ToolButton({
  label,
  caret,
  onClick,
  disabled,
  busy,
  title,
  badge,
  children,
}: ToolButtonProps) {
  return (
    <button
      className={"tb-btn" + (busy ? " busy" : "")}
      onClick={onClick}
      title={busy ? `${label}…` : title ?? label}
      disabled={disabled}
      aria-busy={busy || undefined}
    >
      <span className="tb-btn-label">
        {label}
        {caret && <IconCaretDown className="tb-btn-label-caret" />}
      </span>
      <span className="tb-btn-icon">
        {busy ? <IconSpinner /> : children}
        {badge != null && !busy && <span className="tb-btn-badge">{badge}</span>}
      </span>
    </button>
  );
}
