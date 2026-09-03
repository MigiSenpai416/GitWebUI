import { useEffect, useState } from "react";
import { api } from "../api/client";
import { openExternal } from "../desktop";
import { useStore } from "../state/store";
import "./AccountDialogs.css";

export function AiCommitDialog() {
  const open = useStore((s) => s.aiCommitDialogOpen);
  const close = useStore((s) => s.closeAiCommitDialog);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setApiKey("");
    setModel("");
    setConfigured(false);
    setError(null);
    setLoading(true);
    api.aiCommitInfo(controller.signal).then((info) => {
      if (controller.signal.aborted) return;
      setModel(info.model);
      setConfigured(info.configured);
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't load AI settings.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, close]);

  if (!open) return null;

  const submit = async (clear = false) => {
    if (busy || loading) return;
    setError(null);
    setBusy(true);
    try {
      if (clear) await api.clearAiCommitInfo();
      else await api.setAiCommitInfo(apiKey, model);
      setApiKey("");
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save AI settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop acct-backdrop" onMouseDown={busy ? undefined : close}>
      <form
        className="dialog acct-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-commit-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="acct-head">
          <div className="dialog-title" id="ai-commit-title">Set Up AI Commit Info</div>
          <button type="button" className="acct-x" onClick={close} aria-label="Close" disabled={busy}>✕</button>
        </div>
        <p className="acct-hint">
          Generate a commit title and description with Google AI Studio. Generation sends the complete
          staged diff, or unstaged changes including new files when nothing is staged, to Google.
        </p>
        <label className="acct-field">
          <span>API key</span>
          <input
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={configured ? "Key saved — leave blank to keep it" : "Google AI Studio API key"}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={busy || loading}
          />
        </label>
        <p className="acct-hint">
          <a
            href="https://aistudio.google.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.preventDefault();
              openExternal(e.currentTarget.href);
            }}
          >
            Create API Key
          </a>
        </p>
        <label className="acct-field">
          <span>Model slug</span>
          <input
            value={model}
            placeholder="gemini-2.5-flash"
            spellCheck={false}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy || loading}
          />
        </label>
        <p className="acct-hint">
          Use a model that supports structured JSON output. Settings are shared across repositories.
          The API key is stored on this app's host in its config directory.
        </p>
        {error && <div className="acct-error" role="alert">{error}</div>}
        <div className="dialog-actions acct-actions">
          {configured && (
            <button type="button" className="acct-revoke" onClick={() => void submit(true)} disabled={busy || loading}>
              Clear
            </button>
          )}
          <div className="acct-spacer" />
          <button type="button" className="dialog-btn" onClick={close} disabled={busy}>Cancel</button>
          <button
            type="submit"
            className="dialog-btn dialog-btn-primary"
            disabled={busy || loading || !model.trim() || (!configured && !apiKey.trim())}
          >
            {loading ? "Loading…" : busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
