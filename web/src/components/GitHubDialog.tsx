import { useState } from "react";
import { useStore } from "../state/store";
import "./AccountDialogs.css";

/**
 * Manage the GitHub Personal Access Token used for push/pull and creating
 * repositories: connect, change, or revoke (delete the stored token).
 */
export function GitHubDialog() {
  const open = useStore((s) => s.githubDialogOpen);
  const close = useStore((s) => s.closeGitHubDialog);
  const status = useStore((s) => s.githubStatus);
  const setToken = useStore((s) => s.setGitHubToken);
  const revoke = useStore((s) => s.revokeGitHubToken);

  const [token, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const connected = Boolean(status?.configured);
  const user = status?.user ?? null;

  const save = async () => {
    if (!token.trim()) {
      setError("Paste a Personal Access Token.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await setToken(token.trim());
      setTokenInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't validate the token.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await revoke();
      setTokenInput("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop acct-backdrop" onMouseDown={close}>
      <div className="dialog acct-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="acct-head">
          <IconGitHub />
          <div className="dialog-title">GitHub account</div>
          <button className="acct-x" onClick={close} aria-label="Close">✕</button>
        </div>

        {connected && user ? (
          <div className="acct-connected">
            Connected as <strong>@{user.login}</strong>
            {user.name ? ` (${user.name})` : ""}.
          </div>
        ) : connected ? (
          <div className="acct-warn">
            A token is stored but GitHub rejected it{status?.error ? `: ${status.error}` : ""}. Enter a
            new one below.
          </div>
        ) : (
          <div className="dialog-sub acct-sub">
            Paste a Personal Access Token to push, pull, and create repositories. It's stored on this
            machine and used for GitHub actions.
          </div>
        )}

        <label className="acct-field">
          <span>{connected ? "Replace token" : "Personal Access Token"}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="ghp_… or github_pat_…"
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            disabled={busy}
          />
        </label>

        <p className="acct-hint">
          Create one at GitHub → Settings → Developer settings → Personal access tokens, with{" "}
          <code>repo</code> scope (classic) or Contents read/write (fine-grained).
        </p>

        {error && <div className="acct-error">{error}</div>}

        <div className="dialog-actions acct-actions">
          {connected && (
            <button className="acct-revoke" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          )}
          <div className="acct-spacer" />
          <button className="dialog-btn" onClick={close} disabled={busy}>
            Close
          </button>
          <button className="dialog-btn dialog-btn-primary" onClick={save} disabled={busy}>
            {busy ? "Checking…" : connected ? "Update token" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

function IconGitHub() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" className="acct-gh-logo">
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.2-3.37-1.2-.46-1.18-1.11-1.5-1.11-1.5-.9-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
