import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useStore } from "../state/store";
import { IconPullRequest, IconRefresh, IconSparkle, IconSpinner, IconTrash } from "./icons";
import "./BranchMenu.css";

export function ActionsMenu({ onClose }: { onClose: () => void }) {
  const repo = useStore((s) => s.repo);
  const closeRepo = useStore((s) => s.closeRepo);
  const refreshAll = useStore((s) => s.refreshAll);
  const setError = useStore((s) => s.setError);
  const setNotice = useStore((s) => s.setNotice);
  const openGitHubDialog = useStore((s) => s.openGitHubDialog);
  const openIdentityDialog = useStore((s) => s.openIdentityDialog);
  const openAiCommitDialog = useStore((s) => s.openAiCommitDialog);
  const openPullRequest = useStore((s) => s.openPullRequest);
  const githubStatus = useStore((s) => s.githubStatus);
  const [pruning, setPruning] = useState(false);
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

  const prune = async () => {
    if (pruning) return;
    setPruning(true);
    try {
      await api.pruneRepo();
      setPruning(false);
      setNotice("Pruned unreachable Git objects. GitWebUI recovery backups were kept.");
      onClose();
    } catch (cause) {
      setPruning(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
          onClick={() => void prune()}
          disabled={pruning}
          title="Permanently remove unreachable Git objects now. GitWebUI recovery backups are kept."
        >
          {pruning
            ? <IconSpinner width={14} height={14} className="bmi-icon" />
            : <IconTrash width={14} height={14} className="bmi-icon" />}
          <span className="bmi-name">{pruning ? "Pruning…" : "Prune Repo"}</span>
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
            openAiCommitDialog();
            onClose();
          }}
        >
          <IconSparkle width={14} height={14} className="bmi-icon" />
          <span className="bmi-name">Set Up AI Commit Info</span>
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
