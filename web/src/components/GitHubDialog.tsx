import { useEffect, useRef, useState, type ReactNode } from "react";
import { openExternal, writeClipboard } from "../desktop";
import { useStore } from "../state/store";
import type { GitHubOAuthDeviceFlow, GitHubUser } from "../types";
import { BusyLabel } from "./icons";
import "./AccountDialogs.css";

type View = "method" | "pat" | "oauth";

/** Choose and manage either of the two supported GitHub authentication methods. */
export function GitHubDialog() {
  const open = useStore((s) => s.githubDialogOpen);
  const close = useStore((s) => s.closeGitHubDialog);
  const [view, setView] = useState<View>("method");

  if (!open) return null;

  const closeAll = () => {
    setView("method");
    close();
  };

  if (view === "pat") {
    return <GitHubPatDialog onBack={() => setView("method")} onClose={closeAll} />;
  }
  if (view === "oauth") {
    return <GitHubOAuthDialog onBack={() => setView("method")} onClose={closeAll} />;
  }
  return (
    <GitHubMethodDialog
      onOAuth={() => setView("oauth")}
      onPat={() => setView("pat")}
      onClose={closeAll}
    />
  );
}

function GitHubMethodDialog({
  onOAuth,
  onPat,
  onClose,
}: {
  onOAuth: () => void;
  onPat: () => void;
  onClose: () => void;
}) {
  const status = useStore((s) => s.githubStatus);
  const revoke = useStore((s) => s.revokeGitHubToken);
  const [busy, setBusy] = useState(false);
  const connected = Boolean(status?.configured);
  const user = status?.user ?? null;

  const disconnect = async () => {
    setBusy(true);
    await revoke();
    setBusy(false);
  };

  return (
    <DialogFrame title="Connect GitHub account" onClose={onClose} busy={busy}>
      {connected && user ? (
        <div className="acct-connected" role="status" aria-live="polite">
          Connected as <strong>@{user.login}</strong>
          {user.name ? ` (${user.name})` : ""} using {status?.authMethod === "oauth" ? "GitHub OAuth" : "a Personal Access Token"}.
        </div>
      ) : connected ? (
        <div className="acct-warn">
          The saved GitHub credentials were rejected{status?.error ? `: ${status.error}` : ""}.
          Choose a method below to reconnect.
        </div>
      ) : (
        <div className="dialog-sub acct-sub">
          Choose how GitWebUI should connect to GitHub for repositories, pull requests, push, and pull.
        </div>
      )}

      <div className="acct-methods">
        <button className="acct-method" onClick={onOAuth} disabled={busy}>
          <span className="acct-method-icon"><IconGitHub /></span>
          <span>
            <strong>GitHub OAuth <em>Recommended</em></strong>
            <small>Sign in and authorize GitWebUI in your browser. No token to copy.</small>
          </span>
          <span className="acct-method-arrow">›</span>
        </button>
        <button className="acct-method" onClick={onPat} disabled={busy}>
          <span className="acct-method-icon acct-token-icon" aria-hidden="true">•••</span>
          <span>
            <strong>Personal Access Token</strong>
            <small>Paste a classic or fine-grained token you created on GitHub.</small>
          </span>
          <span className="acct-method-arrow">›</span>
        </button>
      </div>

      <div className="dialog-actions acct-actions">
        {connected && (
          <button className="acct-revoke" onClick={disconnect} disabled={busy}>
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        )}
        <div className="acct-spacer" />
        <button className="dialog-btn" onClick={onClose} disabled={busy}>Close</button>
      </div>
    </DialogFrame>
  );
}

/** Existing PAT flow, now reached after choosing Personal Access Token. */
function GitHubPatDialog({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const status = useStore((s) => s.githubStatus);
  const setToken = useStore((s) => s.setGitHubToken);
  const revoke = useStore((s) => s.revokeGitHubToken);
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    await revoke();
    setTokenInput("");
    setBusy(false);
  };

  return (
    <DialogFrame title="GitHub Personal Access Token" onClose={onClose} busy={busy}>
      {connected && user ? (
        <div className="acct-connected" role="status" aria-live="polite">
          Connected as <strong>@{user.login}</strong>
          {user.name ? ` (${user.name})` : ""}.
        </div>
      ) : connected ? (
        <div className="acct-warn">
          The saved credentials were rejected{status?.error ? `: ${status.error}` : ""}. Enter a new token below.
        </div>
      ) : (
        <div className="dialog-sub acct-sub">
          Paste a Personal Access Token to push, pull, and create repositories. It is stored on this machine and used for GitHub actions.
        </div>
      )}

      <label className="acct-field">
        <span>{connected ? "Replace credentials with token" : "Personal Access Token"}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="ghp_… or github_pat_…"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          disabled={busy}
          autoFocus
        />
      </label>

      <p className="acct-hint">
        Create one at GitHub → Settings → Developer settings → Personal access tokens, with{" "}
        <code>repo</code> scope (classic) or Contents read/write (fine-grained).
      </p>

      {error && <div className="acct-error" role="alert">{error}</div>}

      <div className="dialog-actions acct-actions">
        {connected && (
          <button className="acct-revoke" onClick={disconnect} disabled={busy}>Disconnect</button>
        )}
        <div className="acct-spacer" />
        <button className="dialog-btn" onClick={onBack} disabled={busy}>Back</button>
        <button className="dialog-btn dialog-btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? <BusyLabel>Checking…</BusyLabel> : connected ? "Use this token" : "Connect"}
        </button>
      </div>
    </DialogFrame>
  );
}

/** GitHub OAuth Device Flow: authorize in a real browser while this modal polls. */
function GitHubOAuthDialog({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const status = useStore((s) => s.githubStatus);
  const begin = useStore((s) => s.beginGitHubOAuth);
  const poll = useStore((s) => s.pollGitHubOAuth);
  const cancel = useStore((s) => s.cancelGitHubOAuth);
  const revoke = useStore((s) => s.revokeGitHubToken);
  const [flow, setFlow] = useState<GitHubOAuthDeviceFlow | null>(null);
  const [completedUser, setCompletedUser] = useState<GitHubUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const flowRef = useRef<GitHubOAuthDeviceFlow | null>(null);

  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);

  useEffect(() => () => {
    const active = flowRef.current;
    if (active) void cancel(active.flowId).catch(() => undefined);
  }, [cancel]);

  useEffect(() => {
    if (!flow) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async () => {
      try {
        const result = await poll(flow.flowId);
        if (stopped) return;
        if (result.status === "complete") {
          flowRef.current = null;
          setFlow(null);
          setCompletedUser(result.user);
          setError(null);
          return;
        }
        if (result.status === "pending") {
          setError(result.message ?? null);
          timer = setTimeout(() => void check(), result.retryAfterMs);
        } else {
          flowRef.current = null;
          setFlow(null);
          setError(result.message);
        }
      } catch (e) {
        if (stopped) return;
        flowRef.current = null;
        setFlow(null);
        void cancel(flow.flowId).catch(() => undefined);
        setError(e instanceof Error ? e.message : "Couldn't check GitHub authorization.");
      }
    };

    timer = setTimeout(() => void check(), flow.intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [cancel, flow, poll]);

  const start = async () => {
    setBusy(true);
    setError(null);
    setCompletedUser(null);
    setCopied(false);
    try {
      const next = await begin();
      flowRef.current = next;
      setFlow(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start GitHub OAuth.");
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!flow) return;
    try {
      await writeClipboard(flow.userCode);
      setCopied(true);
    } catch {
      setError("Couldn't copy the code. Select it and copy it manually.");
    }
  };

  const disconnect = async () => {
    setBusy(true);
    await revoke();
    setCompletedUser(null);
    setBusy(false);
  };

  const user = completedUser ?? status?.user ?? null;
  const connectedWithOAuth = completedUser !== null || status?.authMethod === "oauth";

  const back = () => {
    const active = flowRef.current;
    flowRef.current = null;
    setFlow(null);
    if (active) void cancel(active.flowId).catch(() => undefined);
    onBack();
  };

  return (
    <DialogFrame title="GitHub OAuth" onClose={onClose} busy={busy}>
      {completedUser ? (
        <div className="acct-oauth-success" role="status" aria-live="polite">
          <span aria-hidden="true">✓</span>
          <div><strong>Connected to GitHub</strong><small>Signed in as @{completedUser.login}.</small></div>
        </div>
      ) : flow ? (
        <>
          <div className="dialog-sub acct-sub">
            Open GitHub, then enter this one-time code to authorize GitWebUI.
          </div>
          <div className="acct-device-code">
            <code>{flow.userCode}</code>
            <button className="dialog-btn" onClick={() => void copyCode()}>{copied ? "Copied" : "Copy code"}</button>
          </div>
          <button
            className="dialog-btn dialog-btn-primary acct-open-github"
            onClick={() => openExternal(flow.verificationUriComplete ?? flow.verificationUri)}
          >
            Open GitHub in browser
          </button>
          <div className="acct-oauth-wait" role="status" aria-live="polite">
            <BusyLabel>Waiting for authorization…</BusyLabel>
          </div>
        </>
      ) : (
        <>
          {connectedWithOAuth && user ? (
            <div className="acct-connected" role="status" aria-live="polite">
              Connected as <strong>@{user.login}</strong>{user.name ? ` (${user.name})` : ""} using GitHub OAuth.
            </div>
          ) : (
            <div className="dialog-sub acct-sub">
              GitWebUI will show a one-time code. Authorize it on GitHub in your browser, then return here to finish connecting automatically.
            </div>
          )}
          <div className="acct-oauth-scopes">
            <strong>GitHub will ask for:</strong>
            <span>Repository access for push, pull, repositories, and pull requests</span>
            <span>Email read access for your Git commit identity</span>
          </div>
        </>
      )}

      {error && <div className="acct-error" role="alert">{error}</div>}

      <div className="dialog-actions acct-actions">
        {connectedWithOAuth && (
          <button className="acct-revoke" onClick={disconnect} disabled={busy || Boolean(flow)}>Disconnect</button>
        )}
        <div className="acct-spacer" />
        <button className="dialog-btn" onClick={back} disabled={busy}>Back</button>
        {!flow && !completedUser && (
          <button className="dialog-btn dialog-btn-primary" onClick={() => void start()} disabled={busy}>
            {busy ? <BusyLabel>Starting…</BusyLabel> : connectedWithOAuth ? "Reconnect with GitHub" : "Continue with GitHub"}
          </button>
        )}
        {completedUser && <button className="dialog-btn dialog-btn-primary" onClick={onClose}>Done</button>}
      </div>
    </DialogFrame>
  );
}

function DialogFrame({
  title,
  onClose,
  busy,
  children,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ) ?? []).filter((element) => element.offsetParent !== null);
    const elements = focusable();
    const autofocus = dialog?.querySelector<HTMLElement>("[autofocus]") ?? null;
    const first = autofocus && elements.includes(autofocus) ? autofocus : elements[0] ?? dialog;
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const firstElement = elements[0];
      const lastElement = elements[elements.length - 1];
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
      } else if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [busy, onClose]);

  return (
    <div className="dialog-backdrop acct-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        ref={dialogRef}
        className="dialog acct-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="acct-head">
          <IconGitHub />
          <div className="dialog-title">{title}</div>
          <button className="acct-x" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        {children}
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
