import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { BusyLabel, IconMonitor } from "./icons";
import { BrowseButton } from "./BrowseButton";
import { examplePath } from "../desktop";
import "./AccountDialogs.css";
import "./CreateDialog.css";

type Source = "local" | "github";

/**
 * Initialize a brand-new repository — either a purely local one, or a repository
 * created on the connected GitHub account (optionally cloned to a local folder).
 */
export function CreateDialog() {
  const open = useStore((s) => s.createDialogOpen);
  const close = useStore((s) => s.closeCreateDialog);
  const create = useStore((s) => s.createRepo);
  const createGitHub = useStore((s) => s.createGitHubRepoNew);
  const recent = useStore((s) => s.recent);
  const githubStatus = useStore((s) => s.githubStatus);
  const openGitHubDialog = useStore((s) => s.openGitHubDialog);

  const [source, setSource] = useState<Source>("local");
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [branch, setBranch] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<"public" | "private">("public");
  const [cloneAfter, setCloneAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = githubStatus?.user ?? null;
  const connected = Boolean(user);

  // Default the parent folder to the most recent repo's parent, once, on open.
  useEffect(() => {
    if (open) setDir((cur) => cur || parentOf(recent[0] ?? ""));
  }, [open, recent]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, close]);

  if (!open) return null;

  // Whether a local folder is involved (local repos, or a GitHub repo being cloned).
  const usesFolder = source === "local" || cloneAfter;
  const sep = dir.includes("\\") || /^[a-zA-Z]:/.test(dir) ? "\\" : "/";
  const fullPath = name.trim() ? joinPath(dir, name.trim(), sep) : dir;

  const submit = async () => {
    if (!name.trim()) {
      setError("Enter a name for the repository.");
      return;
    }
    if (usesFolder && !dir.trim()) {
      setError("Choose a folder to create the repository in.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (source === "local") {
        await create(dir.trim(), name.trim(), branch.trim());
      } else {
        await createGitHub({
          name: name.trim(),
          description: description.trim(),
          private: access === "private",
          branch: branch.trim(),
          clone: cloneAfter,
          dir: dir.trim(),
        });
      }
      close();
      resetFields();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the repository.");
    } finally {
      setBusy(false);
    }
  };

  const resetFields = () => {
    setName("");
    setDescription("");
    setBranch("");
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !busy) submit();
  };

  const pickSource = (s: Source) => {
    setSource(s);
    setError(null);
  };

  const submitLabel =
    source === "github" && cloneAfter ? "Create Repository and Clone" : "Create Repository";

  return (
    <div className="dialog-backdrop" onMouseDown={busy ? undefined : close}>
      <div className="dialog create-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="acct-head">
          <div className="dialog-title">Initialize a Repository</div>
          <button className="acct-x" onClick={close} aria-label="Close" disabled={busy}>
            ✕
          </button>
        </div>

        <div className="create-body">
          <div className="create-rail">
            <button
              className={"create-rail-item" + (source === "local" ? " active" : "")}
              type="button"
              onClick={() => pickSource("local")}
            >
              <IconMonitor width={15} height={15} /> Local Only
            </button>
            <button
              className={"create-rail-item" + (source === "github" ? " active" : "")}
              type="button"
              onClick={() => pickSource("github")}
            >
              <IconGitHubMark /> GitHub.com
            </button>
          </div>

          <div className="create-panel">
            <div className="create-panel-title">Initialize a Repo</div>

            {source === "github" && !connected ? (
              <div className="acct-connect">
                <p>Connect a GitHub account to create repositories on GitHub.com.</p>
                <button className="dialog-btn dialog-btn-primary" onClick={openGitHubDialog}>
                  Connect GitHub account
                </button>
              </div>
            ) : (
              <>
                {source === "github" && (
                  <div className="create-field">
                    <span className="create-field-label">Account</span>
                    <div className="create-account">
                      {user?.avatarUrl && (
                        <img className="create-avatar" src={user.avatarUrl} alt="" />
                      )}
                      <span>{user?.login}</span>
                    </div>
                  </div>
                )}

                <div className="create-field">
                  <label htmlFor="cr-name">Name</label>
                  <input
                    id="cr-name"
                    autoFocus
                    value={name}
                    spellCheck={false}
                    placeholder="my-repo"
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={onEnter}
                    disabled={busy}
                  />
                </div>

                {source === "github" && (
                  <>
                    <div className="create-field">
                      <label htmlFor="cr-desc">Description</label>
                      <input
                        id="cr-desc"
                        value={description}
                        placeholder="Optional"
                        onChange={(e) => setDescription(e.target.value)}
                        onKeyDown={onEnter}
                        disabled={busy}
                      />
                    </div>
                    <div className="create-field">
                      <label htmlFor="cr-access">Access</label>
                      <select
                        id="cr-access"
                        value={access}
                        onChange={(e) => setAccess(e.target.value as "public" | "private")}
                        disabled={busy}
                      >
                        <option value="public">Public</option>
                        <option value="private">Private</option>
                      </select>
                    </div>
                    <div className="create-field">
                      <span className="create-field-label">Clone after init</span>
                      <label className="create-check">
                        <input
                          type="checkbox"
                          checked={cloneAfter}
                          onChange={(e) => setCloneAfter(e.target.checked)}
                          disabled={busy}
                        />
                      </label>
                    </div>
                  </>
                )}

                {usesFolder && (
                  <>
                    <div className="create-field">
                      <label htmlFor="cr-dir">
                        {source === "github" ? "Where to clone to" : "Initialize in"}
                      </label>
                      <div className="dir-row">
                        <input
                          id="cr-dir"
                          value={dir}
                          spellCheck={false}
                          placeholder={placeholderDir()}
                          onChange={(e) => setDir(e.target.value)}
                          onKeyDown={onEnter}
                          disabled={busy}
                        />
                        <BrowseButton
                          title={source === "github" ? "Where to clone to" : "Initialize in"}
                          defaultPath={dir}
                          disabled={busy}
                          onPick={setDir}
                        />
                      </div>
                    </div>

                    <div className="create-field">
                      <span className="create-field-label">Full path</span>
                      <div className="create-fullpath">{fullPath || "—"}</div>
                    </div>

                    <div className="create-field">
                      <label htmlFor="cr-branch">Default branch name</label>
                      <input
                        id="cr-branch"
                        value={branch}
                        spellCheck={false}
                        placeholder="main"
                        onChange={(e) => setBranch(e.target.value)}
                        onKeyDown={onEnter}
                        disabled={busy}
                      />
                    </div>
                  </>
                )}

                {error && <div className="acct-error create-error">{error}</div>}

                <div className="dialog-actions create-actions">
                  <button className="dialog-btn dialog-btn-primary" onClick={submit} disabled={busy}>
                    {busy ? <BusyLabel>Creating…</BusyLabel> : submitLabel}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function parentOf(p: string): string {
  if (!p) return "";
  const norm = p.replace(/[/\\]+$/, "");
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return cut > 0 ? norm.slice(0, cut) : "";
}

function joinPath(dir: string, name: string, sep: string): string {
  const base = dir.replace(/[/\\]+$/, "");
  return base ? `${base}${sep}${name}` : name;
}

function placeholderDir(): string {
  return examplePath("projects");
}

function IconGitHubMark() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.2-3.37-1.2-.46-1.18-1.11-1.5-1.11-1.5-.9-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
