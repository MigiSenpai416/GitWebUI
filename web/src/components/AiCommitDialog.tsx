import { useEffect, useState } from "react";
import { api } from "../api/client";
import { openExternal } from "../desktop";
import { useStore } from "../state/store";
import type { AiCommitProfile, AiCommitProvider } from "../types";
import "./AccountDialogs.css";

interface AiCommitDraft extends AiCommitProfile {
  apiKey: string;
}

function emptyDrafts(): Record<AiCommitProvider, AiCommitDraft> {
  return {
    google: { configured: false, apiKey: "", model: "", baseUrl: "" },
    openai: { configured: false, apiKey: "", model: "", baseUrl: "https://api.openai.com/v1" },
  };
}

export function AiCommitDialog() {
  const open = useStore((s) => s.aiCommitDialogOpen);
  const close = useStore((s) => s.closeAiCommitDialog);
  const [provider, setProvider] = useState<AiCommitProvider>("google");
  const [drafts, setDrafts] = useState(emptyDrafts);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { apiKey, model, baseUrl, configured } = drafts[provider];
  const google = provider === "google";

  const updateDraft = (patch: Partial<AiCommitDraft>) => {
    setDrafts((current) => ({ ...current, [provider]: { ...current[provider], ...patch } }));
  };

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setProvider("google");
    setDrafts(emptyDrafts());
    setError(null);
    setLoading(true);
    api.aiCommitInfo(controller.signal).then((info) => {
      if (controller.signal.aborted) return;
      setProvider(info.provider);
      setDrafts({
        google: { ...info.profiles.google, apiKey: "" },
        openai: { ...info.profiles.openai, apiKey: "" },
      });
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
      if (clear) await api.clearAiCommitInfo(provider);
      else await api.setAiCommitInfo(apiKey, model, provider, baseUrl);
      setDrafts(emptyDrafts());
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
        className="dialog acct-dialog ai-commit-dialog"
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
        <div className="acct-tabs" role="tablist" aria-label="AI provider">
          {(["google", "openai"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              role="tab"
              className={"acct-tab" + (provider === choice ? " active" : "")}
              aria-selected={provider === choice}
              disabled={busy || loading}
              onClick={() => { setProvider(choice); setError(null); }}
            >
              {choice === "google" ? "Google AI Studio" : "OpenAI Chat Completions"}
            </button>
          ))}
        </div>
        {google ? (
          <p className="acct-hint">
            Generate a commit title and description with Google AI Studio. Generation sends the complete
            staged diff, or unstaged changes including new files when nothing is staged, to Google.
          </p>
        ) : (
          <>
            <p className="acct-hint">
              Generate a commit title and description with an OpenAI-compatible provider. Generation sends the complete
              staged diff, or unstaged changes including new files when nothing is staged, to the configured provider.
            </p>
            <label className="acct-field">
              <span>Base URL</span>
              <input
                value={baseUrl}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
                onChange={(e) => updateDraft({ baseUrl: e.target.value })}
                disabled={busy || loading}
              />
            </label>
            <p className="acct-hint">
              Use the provider's API base URL, usually ending in /v1. Changing it requires entering the API key again.
            </p>
          </>
        )}
        <label className="acct-field">
          <span>API key</span>
          <input
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={configured ? "Key saved — leave blank to keep it" : google ? "Google AI Studio API key" : "Provider API key"}
            onChange={(e) => updateDraft({ apiKey: e.target.value })}
            disabled={busy || loading}
          />
        </label>
        {google && (
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
        )}
        <label className="acct-field">
          <span>Model slug</span>
          <input
            value={model}
            placeholder={google ? "gemini-2.5-flash" : "Provider model slug"}
            spellCheck={false}
            onChange={(e) => updateDraft({ model: e.target.value })}
            disabled={busy || loading}
          />
        </label>
        <p className="acct-hint">
          {google ? "Use a model that supports structured JSON output." : "Use an OpenAI-compatible chat model that supports JSON Schema structured output."}
          {" "}Settings are saved separately for each provider and shared across repositories.
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
            disabled={busy || loading || !model.trim() || (!google && !baseUrl.trim()) || (!configured && !apiKey.trim())}
          >
            {loading ? "Loading…" : busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
