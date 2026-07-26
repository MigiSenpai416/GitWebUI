import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { IconBranch, IconChevronDown, IconClose, IconWorktree } from "./icons";
import { BrowseButton } from "./BrowseButton";
import { examplePath } from "../desktop";
import "./CreateWorktreePanel.css";

/**
 * Full-width panel (right of the sidebar) for creating a worktree: pick a
 * reference to check out, name the new branch, and set the working directory
 * (auto-prefilled from the branch name, but overridable).
 */
export function CreateWorktreePanel() {
  const repo = useStore((s) => s.repo);
  const branches = useStore((s) => s.branches);
  const close = useStore((s) => s.closeWorktreeCreate);
  const createWorktree = useStore((s) => s.createWorktree);

  const repoRoot = repo?.root ?? "";
  const [ref, setRef] = useState(() => repo?.branch ?? "");
  const [newBranch, setNewBranch] = useState("");
  const [dir, setDir] = useState("");
  const [dirEdited, setDirEdited] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ddRef = useRef<HTMLDivElement>(null);

  // Prefill the working directory from the branch name until the user overrides it.
  useEffect(() => {
    if (dirEdited) return;
    setDir(newBranch.trim() ? defaultWorktreePath(repoRoot, newBranch.trim()) : "");
  }, [newBranch, dirEdited, repoRoot]);

  // Close the reference dropdown on an outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setListOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const submit = async () => {
    if (!newBranch.trim()) {
      setError("Enter a branch name to create for the worktree.");
      return;
    }
    if (!dir.trim()) {
      setError("A working directory is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await createWorktree(dir.trim(), ref.trim(), newBranch.trim());
      // On success the store closes this panel.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the worktree.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="worktree-panel">
      <div className="wtp-inner">
        <div className="wtp-head">
          <IconWorktree width={18} height={18} />
          <h2>Create Worktree</h2>
          <button className="wtp-x" onClick={close} aria-label="Close" disabled={busy}>
            <IconClose />
          </button>
        </div>

        <div className="wtp-field">
          <label>Reference to checkout</label>
          <div className="wtp-select" ref={ddRef}>
            <button
              type="button"
              className="wtp-select-btn"
              onClick={() => setListOpen((v) => !v)}
              disabled={busy}
            >
              <IconBranch width={14} height={14} className="wtp-select-icon" />
              <span className={"wtp-select-val" + (ref ? "" : " placeholder")}>
                {ref || "Select a branch…"}
              </span>
              {ref && (
                <span
                  className="wtp-clear"
                  role="button"
                  title="Clear"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRef("");
                  }}
                >
                  ✕
                </span>
              )}
              <IconChevronDown width={12} height={12} />
            </button>
            {listOpen && (
              <ul className="wtp-list">
                {branches.length === 0 ? (
                  <li className="wtp-list-empty">No branches</li>
                ) : (
                  branches.map((b) => (
                    <li key={b.name}>
                      <button
                        type="button"
                        className={"wtp-list-item" + (b.name === ref ? " active" : "")}
                        onClick={() => {
                          setRef(b.name);
                          setListOpen(false);
                        }}
                      >
                        <IconBranch width={13} height={13} />
                        <span>{b.name}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        </div>

        <div className="wtp-field">
          <label htmlFor="wtp-branch">Worktree branch to create</label>
          <input
            id="wtp-branch"
            autoFocus
            value={newBranch}
            spellCheck={false}
            placeholder="new-branch"
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
            disabled={busy}
          />
        </div>

        <div className="wtp-field">
          <label htmlFor="wtp-dir">Working directory</label>
          <div className="dir-row">
            <input
              id="wtp-dir"
              value={dir}
              spellCheck={false}
              placeholder={placeholderDir()}
              onChange={(e) => {
                setDir(e.target.value);
                setDirEdited(true);
              }}
              onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
              disabled={busy}
            />
            <BrowseButton
              title="Working directory"
              defaultPath={dir}
              disabled={busy}
              onPick={(picked) => {
                setDir(picked);
                // Choosing a folder counts as editing it, so the default path
                // stops overwriting the choice when the branch name changes.
                setDirEdited(true);
              }}
            />
          </div>
        </div>

        {error && <div className="wtp-error">{error}</div>}

        <div className="wtp-actions">
          <button className="wtp-create" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create Worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Default worktree path: `<repoParent>/<repoName>.worktrees/<branch>`. */
function defaultWorktreePath(repoRoot: string, branch: string): string {
  const norm = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = norm.lastIndexOf("/");
  const parent = slash >= 0 ? norm.slice(0, slash) : "";
  const base = slash >= 0 ? norm.slice(slash + 1) : norm;
  return parent ? `${parent}/${base}.worktrees/${branch}` : `${base}.worktrees/${branch}`;
}

function placeholderDir(): string {
  return examplePath("projects", "my-repo.worktrees", "feature");
}
