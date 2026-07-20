import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import "./AccountDialogs.css";

/**
 * Set the name + email git records for commits. A connected GitHub account
 * always takes precedence; the fields below are the fallback used when no
 * account is connected.
 */
export function IdentityDialog() {
  const open = useStore((s) => s.identityDialogOpen);
  const close = useStore((s) => s.closeIdentityDialog);
  const identity = useStore((s) => s.identity);
  const save = useStore((s) => s.saveIdentity);
  const clear = useStore((s) => s.clearIdentity);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill the fields from the saved manual identity once it loads.
  useEffect(() => {
    if (open) {
      setName(identity?.manual?.name ?? "");
      setEmail(identity?.manual?.email ?? "");
      setError(null);
    }
  }, [open, identity?.manual?.name, identity?.manual?.email]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, close]);

  if (!open) return null;

  const github = identity?.github ?? null;
  const effective = identity?.effective ?? null;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await save(name, email);
      if (!github) close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the identity.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop acct-backdrop" onMouseDown={busy ? undefined : close}>
      <div className="dialog acct-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="acct-head">
          <div className="dialog-title">Commit identity</div>
          <button className="acct-x" onClick={close} aria-label="Close" disabled={busy}>✕</button>
        </div>

        {effective ? (
          <div className="acct-connected">
            Commits are authored as <strong>{effective.name}</strong> &lt;{effective.email}&gt;
            {github ? " — from your connected GitHub account." : "."}
          </div>
        ) : (
          <div className="acct-warn">
            No commit identity is set. Add one below (or connect a GitHub account) so your commits
            are attributed.
          </div>
        )}

        {github && (
          <p className="acct-hint">
            A GitHub account is connected, so its identity is used for commits. The fields below are
            a fallback for when no account is connected.
          </p>
        )}

        <label className="acct-field">
          <span>Name</span>
          <input
            autoFocus
            value={name}
            placeholder="Ada Lovelace"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="acct-field">
          <span>Email</span>
          <input
            value={email}
            spellCheck={false}
            placeholder="ada@example.com"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
            disabled={busy}
          />
        </label>

        {error && <div className="acct-error">{error}</div>}

        <div className="dialog-actions acct-actions">
          {identity?.manual && (
            <button className="acct-revoke" onClick={() => clear()} disabled={busy}>
              Clear
            </button>
          )}
          <div className="acct-spacer" />
          <button className="dialog-btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="dialog-btn dialog-btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
