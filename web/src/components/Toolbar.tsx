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
  const [branchOpen, setBranchOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  if (!repo) return null;

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
          <ToolButton label="Pull" onClick={() => pull()} disabled={remoteBusy}>
            <IconPull />
          </ToolButton>
          <ToolButton label="Push" onClick={() => push()} disabled={remoteBusy}>
            <IconPush />
          </ToolButton>
          <ToolButton label="Branch" onClick={() => setBranchOpen((v) => !v)}>
            <IconBranch />
          </ToolButton>
          <ToolButton label="Stash" onClick={soon("Stash")}>
            <IconStash />
          </ToolButton>
          <ToolButton label="Pop" onClick={soon("Pop")}>
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
  children: React.ReactNode;
}

function ToolButton({ label, caret, onClick, disabled, children }: ToolButtonProps) {
  return (
    <button className="tb-btn" onClick={onClick} title={label} disabled={disabled}>
      <span className="tb-btn-label">
        {label}
        {caret && <IconCaretDown className="tb-btn-label-caret" />}
      </span>
      <span className="tb-btn-icon">{children}</span>
    </button>
  );
}
