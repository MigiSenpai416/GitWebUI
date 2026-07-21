import { useEffect, useRef, useState } from "react";
import { useStore } from "./state/store";
import { applyFavicon, repoColor } from "./brand";
import { RepoPicker } from "./components/RepoPicker";
import { Toolbar } from "./components/Toolbar";
import { CommitList } from "./components/CommitList";
import { ChangesPanel } from "./components/ChangesPanel";
import { ConflictPanel } from "./components/ConflictPanel";
import { ConflictResolver } from "./components/ConflictResolver";
import { CreateWorktreePanel } from "./components/CreateWorktreePanel";
import { CommitBox } from "./components/CommitBox";
import { CommitDetails } from "./components/CommitDetails";
import { DiffViewer } from "./components/DiffViewer/DiffViewer";
import { CommitContextMenu } from "./components/CommitContextMenu";
import { StashContextMenu } from "./components/StashContextMenu";
import { ChangesContextMenu } from "./components/ChangesContextMenu";
import { CreateBranchDialog } from "./components/CreateBranchDialog";
import { ConfirmBar } from "./components/ConfirmBar";
import { AuthGate } from "./components/AuthGate";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { AddRemoteDialog } from "./components/AddRemoteDialog";
import { CloneDialog } from "./components/CloneDialog";
import { CreateDialog } from "./components/CreateDialog";
import { GitHubDialog } from "./components/GitHubDialog";
import { PullRequestDialog } from "./components/PullRequestDialog";
import { IdentityDialog } from "./components/IdentityDialog";
import { IconCheck, IconWarning } from "./components/icons";

export function App() {
  const authState = useStore((s) => s.authState);
  const repo = useStore((s) => s.repo);
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  const setError = useStore((s) => s.setError);
  const setNotice = useStore((s) => s.setNotice);
  const selectedCommitHash = useStore((s) => s.selectedCommitHash);
  const selectedFile = useStore((s) => s.selectedFile);
  const mergeActive = useStore((s) => s.mergeState?.active ?? false);
  const conflictPath = useStore((s) => s.conflictPath);
  const worktreeCreateOpen = useStore((s) => s.worktreeCreateOpen);
  const init = useStore((s) => s.init);
  const refreshAll = useStore((s) => s.refreshAll);
  const lastRefresh = useRef(0);

  useEffect(() => {
    init();
  }, [init]);

  // Re-sync when the user returns to the tab/window. Both `focus` and
  // `visibilitychange` can fire together on a tab switch, so coalesce them.
  useEffect(() => {
    const maybeRefresh = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastRefresh.current < 800) return;
      lastRefresh.current = now;
      refreshAll();
    };
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", maybeRefresh);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", maybeRefresh);
    };
  }, [refreshAll]);

  // Name the browser tab after the repo in view and tint the favicon with that
  // repo's color, so several open GitWebUI tabs are told apart the same way the
  // in-app tabs are.
  useEffect(() => {
    const name = repo ? basename(repo.root) : "";
    document.title = name ? `${name} · GitWebUI` : "GitWebUI";
    applyFavicon(repoColor(repo?.root ?? null));
  }, [repo]);

  const toasts = (
    <>
      <ConfirmBar />
      {(error || notice) && (
        <div className="toast-stack">
          {error && <Toast kind="error" message={error} onClose={() => setError(null)} />}
          {notice && <Toast kind="notice" message={notice} onClose={() => setNotice(null)} />}
        </div>
      )}
    </>
  );

  // Auth gate: nothing else renders until the session is established.
  if (authState === "loading") {
    return <div className="app-loading">{toasts}</div>;
  }
  if (authState !== "ok") {
    return (
      <>
        <AuthGate />
        {toasts}
      </>
    );
  }

  return (
    <div className="app">
      <TabBar />
      {repo ? (
        <>
          <Toolbar />
          <div className="app-body">
            <Sidebar />
            {worktreeCreateOpen ? (
              <CreateWorktreePanel />
            ) : (
              <>
                <div className="commit-pane">
                  <CommitList />
                  {!conflictPath && selectedFile && <DiffViewer />}
                </div>
                <div className="side-pane">
                  {selectedCommitHash ? (
                    <CommitDetails />
                  ) : mergeActive ? (
                    <>
                      <ConflictPanel />
                      <CommitBox />
                    </>
                  ) : (
                    <>
                      <ChangesPanel />
                      <CommitBox />
                    </>
                  )}
                </div>
                {conflictPath && <ConflictResolver />}
              </>
            )}
          </div>
        </>
      ) : (
        <RepoPicker />
      )}
      <CommitContextMenu />
      <StashContextMenu />
      <ChangesContextMenu />
      <CreateBranchDialog />
      <AddRemoteDialog />
      <CloneDialog />
      <CreateDialog />
      <GitHubDialog />
      <PullRequestDialog />
      <IdentityDialog />
      {toasts}
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** How long a toast stays up, and how long its exit takes (mirrors theme.css). */
const TOAST_LIFE_MS = 5000;
const TOAST_EXIT_MS = 170;

/**
 * A result of the last action, bottom-left. It retreats the way it arrived —
 * on its own after five seconds, or when dismissed.
 */
function Toast({
  kind,
  message,
  onClose,
}: {
  kind: "error" | "notice";
  message: string;
  onClose: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  // Held in a ref so the exit timer isn't restarted by the parent re-rendering.
  const close = useRef(onClose);
  close.current = onClose;

  // A new message reuses this toast, so restart its life with it.
  useEffect(() => {
    setLeaving(false);
    const t = setTimeout(() => setLeaving(true), TOAST_LIFE_MS);
    return () => clearTimeout(t);
  }, [message]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => close.current(), TOAST_EXIT_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  return (
    <div
      className={"toast toast-" + kind + (leaving ? " leaving" : "")}
      role={kind === "error" ? "alert" : "status"}
    >
      <span className="toast-rail" aria-hidden />
      <span className="toast-icon" aria-hidden>
        {kind === "error" ? (
          <IconWarning width={15} height={15} />
        ) : (
          <IconCheck width={15} height={15} />
        )}
      </span>
      <span className="toast-msg">{message}</span>
      <button className="toast-x" onClick={() => setLeaving(true)} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
