import { useEffect, useRef } from "react";
import { useStore } from "./state/store";
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
import { IdentityDialog } from "./components/IdentityDialog";

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

  // Auto-dismiss the neutral notice toast.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  const toasts = (
    <>
      <ConfirmBar />
      {error && <Toast kind="error" message={error} onClose={() => setError(null)} />}
      {notice && <Toast kind="notice" message={notice} onClose={() => setNotice(null)} />}
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
      <IdentityDialog />
      {toasts}
    </div>
  );
}

function Toast({
  kind,
  message,
  onClose,
}: {
  kind: "error" | "notice";
  message: string;
  onClose: () => void;
}) {
  return (
    <div className={"toast toast-" + kind} role={kind === "error" ? "alert" : "status"}>
      <span>{message}</span>
      <button onClick={onClose} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
