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
          <ToolButton label="Pull" caret onClick={soon("Pull")}>
            <IconPull />
          </ToolButton>
          <ToolButton label="Push" onClick={soon("Push")}>
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
      </div>
    </div>
  );
}

interface ToolButtonProps {
  label: string;
  caret?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}

function ToolButton({ label, caret, onClick, children }: ToolButtonProps) {
  return (
    <button className="tb-btn" onClick={onClick} title={label}>
      <span className="tb-btn-label">
        {label}
        {caret && <IconCaretDown className="tb-btn-label-caret" />}
      </span>
      <span className="tb-btn-icon">{children}</span>
    </button>
  );
}
