import { useEffect, useRef, useState } from "react";
import { BusyLabel } from "./icons";
import { useStore } from "../state/store";
import { api } from "../api/client";
import type { GitHubRepo } from "../types";
import "./AccountDialogs.css";
import "./CloneDialog.css";

type Source = "url" | "github";

/**
 * Clone a repository into a local folder — either from an arbitrary URL or by
 * searching the connected GitHub account's repositories (public and private).
 */
export function CloneDialog() {
  const open = useStore((s) => s.cloneDialogOpen);
  const close = useStore((s) => s.closeCloneDialog);
  const clone = useStore((s) => s.cloneRepo);
  const recent = useStore((s) => s.recent);
  const status = useStore((s) => s.githubStatus);
  const openGitHubDialog = useStore((s) => s.openGitHubDialog);

  const [source, setSource] = useState<Source>("url");
  const [dir, setDir] = useState(() => parentOf(recent[0] ?? ""));
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = Boolean(status?.user);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, close]);

  if (!open) return null;

  const clearErr = () => setError(null);

  const cloneUrl = async (u: string) => {
    if (!dir.trim()) {
      setError("Choose a folder to clone into.");
      return;
    }
    if (!u.trim()) {
      setError("Enter a repository to clone.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await clone(dir.trim(), u.trim());
      close();
      setUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't clone the repository.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={busy ? undefined : close}>
      <div className="dialog clone-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="acct-head">
          <div className="dialog-title">Clone a repository</div>
          <button className="acct-x" onClick={close} aria-label="Close" disabled={busy}>✕</button>
        </div>

        <div className="clone-body">
          <div className="clone-rail">
            <button
              className={"clone-rail-item" + (source === "url" ? " active" : "")}
              onClick={() => { setSource("url"); clearErr(); }}
            >
              <IconGlobe /> Clone with URL
            </button>
            <button
              className={"clone-rail-item" + (source === "github" ? " active" : "")}
              onClick={() => { setSource("github"); clearErr(); }}
            >
              <IconGitHubMark /> GitHub.com
            </button>
          </div>

          <div className="clone-panel">
            <label className="acct-field">
              <span>Where to clone to</span>
              <input
                value={dir}
                spellCheck={false}
                placeholder={placeholderDir()}
                onChange={(e) => setDir(e.target.value)}
                disabled={busy}
              />
            </label>

            {source === "url" ? (
              <>
                <label className="acct-field">
                  <span>URL</span>
                  <input
                    autoFocus
                    value={url}
                    spellCheck={false}
                    placeholder="https://github.com/owner/repo.git"
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !busy && cloneUrl(url)}
                    disabled={busy}
                  />
                </label>
                {error && <div className="acct-error">{error}</div>}
                <div className="dialog-actions clone-actions">
                  <button className="dialog-btn dialog-btn-primary" onClick={() => cloneUrl(url)} disabled={busy}>
                    {busy ? <BusyLabel>Cloning…</BusyLabel> : "Clone the repo!"}
                  </button>
                </div>
              </>
            ) : !connected ? (
              <div className="acct-connect">
                <p>Connect a GitHub account to browse and clone your repositories, including private ones.</p>
                <button className="dialog-btn dialog-btn-primary" onClick={openGitHubDialog}>
                  Connect GitHub account
                </button>
              </div>
            ) : (
              <GitHubPicker
                account={status?.user?.login ?? ""}
                busy={busy}
                error={error}
                onError={setError}
                onClone={cloneUrl}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Account field + searchable repository combobox for the GitHub source. */
function GitHubPicker({
  account,
  busy,
  error,
  onError,
  onClone,
}: {
  account: string;
  busy: boolean;
  error: string | null;
  onError: (msg: string | null) => void;
  onClone: (url: string) => void;
}) {
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GitHubRepo | null>(null);
  const [openList, setOpenList] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Load the account's repos once when the picker mounts.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .githubRepos()
      .then(({ repos }) => !cancelled && setRepos(repos))
      .catch((e) => !cancelled && onError(e instanceof Error ? e.message : "Couldn't load repositories."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the dropdown on an outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = query.trim().toLowerCase();
  const matches = (repos ?? [])
    .filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q))
    .slice(0, 60);

  const choose = (r: GitHubRepo) => {
    setSelected(r);
    setQuery(r.fullName);
    setOpenList(false);
    onError(null);
  };

  const submit = () => {
    if (selected && selected.fullName === query.trim()) {
      onClone(selected.cloneUrl);
      return;
    }
    // Fall back to free text: "owner/repo", bare "repo", or a full URL.
    const raw = query.trim();
    if (!raw) {
      onError("Choose or type a repository.");
      return;
    }
    const cloneUrl = /^https?:\/\//i.test(raw)
      ? raw
      : `https://github.com/${raw.includes("/") ? raw : `${account}/${raw}`}.git`;
    onClone(cloneUrl);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpenList(true);
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (openList && matches[active]) choose(matches[active]);
      else if (!busy) submit();
    }
  };

  return (
    <>
      <label className="acct-field">
        <span>Account</span>
        <input value={`@${account}`} disabled readOnly />
      </label>

      <label className="acct-field clone-combo-field">
        <span>Repository</span>
        <div className="clone-combo" ref={boxRef}>
          <input
            autoFocus
            value={query}
            spellCheck={false}
            placeholder={loading ? "Loading repositories…" : "Search your repositories…"}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
              setOpenList(true);
              setActive(0);
            }}
            onFocus={() => setOpenList(true)}
            onKeyDown={onKeyDown}
            disabled={busy}
          />
          {openList && (repos?.length ?? 0) > 0 && (
            <ul className="clone-list">
              {matches.length === 0 ? (
                <li className="clone-list-empty">No repositories match “{query}”.</li>
              ) : (
                matches.map((r, i) => (
                  <li key={r.fullName}>
                    <button
                      type="button"
                      className={"clone-list-item" + (i === active ? " active" : "")}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(r);
                      }}
                      onMouseEnter={() => setActive(i)}
                    >
                      <span className="clone-list-name">{r.fullName}</span>
                      <span className={"clone-vis " + (r.private ? "private" : "public")}>
                        {r.private ? "Private" : "Public"}
                      </span>
                      {r.description && <span className="clone-list-desc">{r.description}</span>}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      </label>

      {error && <div className="acct-error">{error}</div>}
      <div className="dialog-actions clone-actions">
        <button className="dialog-btn dialog-btn-primary" onClick={submit} disabled={busy}>
          {busy ? <BusyLabel>Cloning…</BusyLabel> : "Clone the repo!"}
        </button>
      </div>
    </>
  );
}

function parentOf(p: string): string {
  if (!p) return "";
  const norm = p.replace(/[/\\]+$/, "");
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return cut > 0 ? norm.slice(0, cut) : "";
}

function placeholderDir(): string {
  return navigator.userAgent.includes("Win") ? "C:\\Users\\you\\projects" : "/home/you/projects";
}

function IconGlobe() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
    </svg>
  );
}

function IconGitHubMark() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.2-3.37-1.2-.46-1.18-1.11-1.5-1.11-1.5-.9-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
