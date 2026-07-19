import { useEffect } from "react";
import { useStore } from "./state/store";
import { RepoPicker } from "./components/RepoPicker";
import { Toolbar } from "./components/Toolbar";
import { CommitList } from "./components/CommitList";
import { ChangesPanel } from "./components/ChangesPanel";
import { CommitBox } from "./components/CommitBox";
import { CommitDetails } from "./components/CommitDetails";
import { DiffViewer } from "./components/DiffViewer/DiffViewer";

export function App() {
  const repo = useStore((s) => s.repo);
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  const setError = useStore((s) => s.setError);
  const setNotice = useStore((s) => s.setNotice);
  const selectedCommitHash = useStore((s) => s.selectedCommitHash);
  const selectedFile = useStore((s) => s.selectedFile);
  const init = useStore((s) => s.init);

  useEffect(() => {
    init();
  }, [init]);

  // Auto-dismiss the neutral notice toast.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  const toasts = (
    <>
      {error && <Toast kind="error" message={error} onClose={() => setError(null)} />}
      {notice && <Toast kind="notice" message={notice} onClose={() => setNotice(null)} />}
    </>
  );

  if (!repo) {
    return (
      <>
        <RepoPicker />
        {toasts}
      </>
    );
  }

  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        <div className="commit-pane">
          <CommitList />
          {selectedFile && <DiffViewer />}
        </div>
        <div className="side-pane">
          {selectedCommitHash ? (
            <CommitDetails />
          ) : (
            <>
              <ChangesPanel />
              <CommitBox />
            </>
          )}
        </div>
      </div>
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
