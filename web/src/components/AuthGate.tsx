import { useState } from "react";
import { useStore } from "../state/store";
import { IconMark } from "./icons";
import "./AuthGate.css";

/**
 * Full-screen access gate shown until the user is authenticated. On first run
 * (no password configured) it asks the user to set one; otherwise it asks for
 * the existing password, with an optional 7-day "Remember me".
 */
export function AuthGate() {
  const mode = useStore((s) => s.authState); // "setup" | "login"
  const setupPassword = useStore((s) => s.setupPassword);
  const login = useStore((s) => s.login);

  const isSetup = mode === "setup";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (isSetup) {
      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }
      if (password !== confirm) {
        setError("Passwords don't match.");
        return;
      }
    } else if (!password) {
      setError("Enter your password.");
      return;
    }

    setBusy(true);
    try {
      if (isSetup) await setupPassword(password, remember);
      else await login(password, remember);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPassword("");
      setConfirm("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <IconMark className="auth-logo" width={30} height={30} aria-hidden="true" />
          <h1>GitWebUI</h1>
        </div>
        <p className="auth-sub">
          {isSetup
            ? "Set a password to protect this instance. You'll need it each time you open the web UI."
            : "Enter your password to access this instance."}
        </p>

        <label className="auth-field">
          <span>Password</span>
          <input
            autoFocus
            type="password"
            autoComplete={isSetup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>

        {isSetup && (
          <label className="auth-field">
            <span>Confirm password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
          </label>
        )}

        <label className="auth-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={busy}
          />
          <span>Remember me for 7 days</span>
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
          {busy ? "Please wait…" : isSetup ? "Set password & continue" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
