import { useEffect, useRef } from "react";
import { useStore } from "./state/store";
import { applyFavicon, repoColor } from "./brand";
import { useDesktopMenu } from "./useDesktopMenu";
import { RepoPicker } from "./components/RepoPicker";
import { Toolbar } from "./components/Toolbar";
import { CommitList } from "./components/CommitList";
import { ChangesPanel } from "./components/ChangesPanel";
import { ConflictPanel } from "./components/ConflictPanel";
import { ConflictResolver } from "./components/ConflictResolver";
import { CreateWorktreePanel } from "./components/CreateWorktreePanel";
import { CommitBox } from "./components/CommitBox";
import { CommitDetails } from "./components/CommitDetails";
import { StashDetails } from "./components/StashDetails";
import { TerminalPanel } from "./components/TerminalPanel";
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
import { ToastStack } from "./components/ToastStack";

export function App() {
  const authState = useStore((s) => s.authState);
  const repo = useStore((s) => s.repo);
  const selectedCommitHash = useStore((s) => s.selectedCommitHash);
  const selectedStashHash = useStore((s) => s.selectedStashHash);
  const selectedFile = useStore((s) => s.selectedFile);
  const mergeActive = useStore((s) => s.mergeState?.active ?? false);
  const conflictPath = useStore((s) => s.conflictPath);
  const worktreeCreateOpen = useStore((s) => s.worktreeCreateOpen);
  const init = useStore((s) => s.init);
  const refreshAll = useStore((s) => s.refreshAll);
  const lastRefresh = useRef(0);

  // The native menu, when there is one. Registered unconditionally because
  // hooks must be, and inert in a browser.
  useDesktopMenu();

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

  const overlays = (
    <>
      <ConfirmBar />
      <ToastStack />
    </>
  );

  // Auth gate: nothing else renders until the session is established.
  if (authState === "loading") {
    return <div className="app-loading">{overlays}</div>;
  }
  if (authState !== "ok") {
    return (
      <>
        <AuthGate />
        {overlays}
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
                  ) : selectedStashHash ? (
                    <StashDetails />
                  ) : mergeActive ? (
                    <>
                      <ConflictPanel />
                      <CommitBox key={repo.root} />
                    </>
                  ) : (
                    <>
                      <ChangesPanel />
                      <CommitBox key={repo.root} />
                    </>
                  )}
                </div>
                {conflictPath && <ConflictResolver />}
              </>
            )}
          </div>
          <TerminalPanel />
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
      {overlays}
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
