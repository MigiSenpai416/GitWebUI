import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import "./RepoPicker.css";

export function RepoPicker() {
  const recent = useStore((s) => s.recent);
  const opening = useStore((s) => s.opening);
  const openRepo = useStore((s) => s.openRepo);
  const loadRecent = useStore((s) => s.loadRecent);
  const [path, setPath] = useState("");

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  const submit = (value: string) => {
    const p = value.trim();
    if (p && !opening) openRepo(p);
  };

  return (
    <div className="picker">
      <div className="picker-card">
        <div className="picker-brand">
          <span className="picker-logo">◑</span>
          <h1>GitWebUI</h1>
        </div>
        <p className="picker-sub">
          Open a local repository by its absolute path on this machine.
        </p>
        <form
          className="picker-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit(path);
          }}
        >
          <input
            autoFocus
            spellCheck={false}
            placeholder={placeholderForOS()}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={opening || !path.trim()}>
            {opening ? "Opening…" : "Open"}
          </button>
        </form>

        {recent.length > 0 && (
          <div className="picker-recent">
            <div className="picker-recent-label">Recent</div>
            <ul>
              {recent.map((r) => (
                <li key={r}>
                  <button className="recent-item" onClick={() => submit(r)} disabled={opening}>
                    <span className="recent-name">{basename(r)}</span>
                    <span className="recent-path">{r}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function placeholderForOS(): string {
  const win = navigator.userAgent.includes("Win");
  return win ? "C:\\Users\\you\\projects\\my-repo" : "/home/you/projects/my-repo";
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
