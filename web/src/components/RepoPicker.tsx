import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { IconCloud, IconFolder, IconPlus } from "./icons";
import "./RepoPicker.css";

/** The "New Tab" scene: open, clone, or create a repository, with a Recent list. */
export function RepoPicker() {
  const recent = useStore((s) => s.recent);
  const opening = useStore((s) => s.opening);
  const openRepo = useStore((s) => s.openRepo);
  const loadRecent = useStore((s) => s.loadRecent);
  const openCloneDialog = useStore((s) => s.openCloneDialog);
  const openCreateDialog = useStore((s) => s.openCreateDialog);

  const [showPath, setShowPath] = useState(false);
  const [path, setPath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  const submit = (value: string) => {
    const p = value.trim();
    if (p && !opening) openRepo(p);
  };

  const toggleOpen = () => {
    setShowPath((v) => !v);
    // Focus the field once it's revealed.
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className="picker">
      <div className="picker-inner">
        <h2 className="picker-heading">Repositories</h2>

        <div className="picker-actions">
          <button className="picker-action" onClick={toggleOpen}>
            <IconFolder width={18} height={18} />
            Open
          </button>
          <button className="picker-action" onClick={openCloneDialog}>
            <IconCloud width={18} height={18} />
            Clone
          </button>
          <button className="picker-action" onClick={openCreateDialog}>
            <IconPlus width={18} height={18} />
            Create
          </button>
        </div>

        {showPath && (
          <form
            className="picker-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit(path);
            }}
          >
            <input
              ref={inputRef}
              spellCheck={false}
              placeholder={placeholderForOS()}
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={opening || !path.trim()}>
              {opening ? "Opening…" : "Open"}
            </button>
          </form>
        )}

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
