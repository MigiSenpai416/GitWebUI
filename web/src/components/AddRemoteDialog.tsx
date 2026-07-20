import { useState } from "react";
import { useStore } from "../state/store";
import "./AccountDialogs.css";

type Tab = "url" | "github";

/**
 * Add a remote to the repo, either by pasting a URL or by creating a new
 * GitHub repository for the connected account and pushing local refs to it.
 */
export function AddRemoteDialog() {
  const open = useStore((s) => s.addRemoteOpen);
  const close = useStore((s) => s.closeAddRemote);
  const repo = useStore((s) => s.repo);
  const status = useStore((s) => s.githubStatus);
  const addRemote = useStore((s) => s.addRemote);
  const createRepo = useStore((s) => s.createGitHubRepo);
  const openGitHubDialog = useStore((s) => s.openGitHubDialog);
  const remoteBusy = useStore((s) => s.remoteBusy);

  const [tab, setTab] = useState<Tab>("url");
  const [error, setError] = useState<string | null>(null);

  // URL tab
  const [urlName, setUrlName] = useState("origin");
  const [url, setUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);

  // GitHub tab
  const [repoName, setRepoName] = useState(() => basename(repo?.root ?? ""));
  const [ghRemoteName, setGhRemoteName] = useState("origin");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");

  if (!open) return null;

  const connected = Boolean(status?.user);

  const submitUrl = async () => {
    if (!urlName.trim() || !url.trim()) {
      setError("Enter a remote name and URL.");
      return;
    }
    setError(null);
    setUrlBusy(true);
    try {
      await addRemote(urlName.trim(), url.trim());
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the remote.");
    } finally {
      setUrlBusy(false);
    }
  };

  const submitGitHub = async () => {
    if (!repoName.trim()) {
      setError("Enter a repository name.");
      return;
    }
    setError(null);
    try {
      await createRepo({
        name: repoName.trim(),
        description: description.trim(),
        private: visibility === "private",
        remoteName: ghRemoteName.trim() || "origin",
      });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the repository.");
    }
  };

  return (
    <div className="dialog-backdrop acct-backdrop" onMouseDown={close}>
      <div className="dialog acct-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="acct-head">
          <div className="dialog-title">Add remote</div>
          <button className="acct-x" onClick={close} aria-label="Close">✕</button>
        </div>

        <div className="acct-tabs">
          <button className={"acct-tab" + (tab === "url" ? " active" : "")} onClick={() => { setTab("url"); setError(null); }}>
            <IconGlobe /> URL
          </button>
          <button className={"acct-tab" + (tab === "github" ? " active" : "")} onClick={() => { setTab("github"); setError(null); }}>
            <IconGitHubMark /> GitHub
          </button>
        </div>

        {tab === "url" ? (
          <>
            <label className="acct-field">
              <span>Remote name</span>
              <input value={urlName} spellCheck={false} onChange={(e) => setUrlName(e.target.value)} disabled={urlBusy} />
            </label>
            <label className="acct-field">
              <span>URL</span>
              <input
                autoFocus
                placeholder="https://github.com/you/repo.git"
                value={url}
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitUrl()}
                disabled={urlBusy}
              />
            </label>
            {error && <div className="acct-error">{error}</div>}
            <div className="dialog-actions acct-actions">
              <div className="acct-spacer" />
              <button className="dialog-btn" onClick={close} disabled={urlBusy}>Cancel</button>
              <button className="dialog-btn dialog-btn-primary" onClick={submitUrl} disabled={urlBusy}>
                {urlBusy ? "Adding…" : "Add remote"}
              </button>
            </div>
          </>
        ) : !connected ? (
          <div className="acct-connect">
            <p>Connect a GitHub account to create a repository and push to it.</p>
            <button className="dialog-btn dialog-btn-primary" onClick={openGitHubDialog}>
              Connect GitHub account
            </button>
          </div>
        ) : (
          <>
            <label className="acct-field">
              <span>Account</span>
              <input value={`@${status?.user?.login ?? ""}`} disabled readOnly />
            </label>
            <label className="acct-field">
              <span>Repository name</span>
              <input autoFocus value={repoName} spellCheck={false} onChange={(e) => setRepoName(e.target.value)} disabled={remoteBusy} />
            </label>
            <label className="acct-field">
              <span>Remote name</span>
              <input value={ghRemoteName} spellCheck={false} onChange={(e) => setGhRemoteName(e.target.value)} disabled={remoteBusy} />
            </label>
            <label className="acct-field">
              <span>Description <span className="acct-optional">(optional)</span></span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={remoteBusy} />
            </label>
            <label className="acct-field">
              <span>Access</span>
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "private")} disabled={remoteBusy}>
                <option value="public">Public</option>
                <option value="private">Private</option>
              </select>
            </label>
            {error && <div className="acct-error">{error}</div>}
            <div className="dialog-actions acct-actions">
              <div className="acct-spacer" />
              <button className="dialog-btn" onClick={close} disabled={remoteBusy}>Cancel</button>
              <button className="dialog-btn dialog-btn-primary" onClick={submitGitHub} disabled={remoteBusy}>
                {remoteBusy ? "Creating…" : "Create remote and push local refs"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
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
