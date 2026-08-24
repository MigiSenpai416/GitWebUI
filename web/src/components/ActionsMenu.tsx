import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { IconPullRequest, IconRefresh } from "./icons";
import "./BranchMenu.css";

export function ActionsMenu({ onClose }: { onClose: () => void }) {
  const repo = useStore((s) => s.repo);
  const closeRepo = useStore((s) => s.closeRepo);
  const refreshAll = useStore((s) => s.refreshAll);
  const openGitHubDialog = useStore((s) => s.openGitHubDialog);
  const openIdentityDialog = useStore((s) => s.openIdentityDialog);
  const openPullRequest = useStore((s) => s.openPullRequest);
  const githubStatus = useStore((s) => s.githubStatus);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const refresh = () => {
    void refreshAll();
    onClose();
  };

  return (
    <div className="branch-menu actions-menu" ref={ref}>
      <div className="branch-menu-head">Repository</div>
      <div className="branch-menu-list">
        <div className="actions-repo-path" title={repo?.root}>
          {repo?.root}
        </div>
        <button className="branch-menu-item" onClick={refresh}>
          <IconRefresh width={14} height={14} className="bmi-icon" />
          <span className="bmi-name">Refresh</span>
        </button>
        <button
          className="branch-menu-item"
          onClick={() => {
            openPullRequest();
            onClose();
          }}
        >
          <IconPullRequest width={14} height={14} className="bmi-icon" />
          <span className="bmi-name">Create pull request…</span>
        </button>
        <button
          className="branch-menu-item"
          onClick={() => {
            openIdentityDialog();
            onClose();
          }}
        >
          <span className="bmi-check" />
          <span className="bmi-name">Commit identity…</span>
        </button>
        <button
          className="branch-menu-item"
          onClick={() => {
            openGitHubDialog();
            onClose();
          }}
        >
          <span className="bmi-check" />
          <span className="bmi-name">
            {githubStatus?.user ? `GitHub: @${githubStatus.user.login}` : "Connect GitHub account…"}
          </span>
        </button>
        <button
          className="branch-menu-item"
          onClick={() => {
            closeRepo();
            onClose();
          }}
        >
          <span className="bmi-check" />
          <span className="bmi-name">Open a different repository…</span>
        </button>
      </div>
    </div>
  );
}
