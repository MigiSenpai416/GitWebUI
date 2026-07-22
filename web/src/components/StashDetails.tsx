import { useState } from "react";
import { useStore } from "../state/store";
import type { CommitFile, StashEntry } from "../types";
import { ChangedFiles } from "./ChangedFiles";
import { IconPop } from "./icons";
// The stash pane wears the commit pane's frame — same header, meta rows and
// scroll behaviour — so it pulls in those styles rather than restating them.
import "./CommitDetails.css";
import "./StashDetails.css";

/**
 * A stash open in the side pane: what it holds, and the title/description the
 * user keeps on it. git gives every stash the same "WIP on main:" label, which
 * says nothing about why it was put down — the note is where that goes, and it
 * is what the graph row shows once written.
 */
export function StashDetails() {
  const hash = useStore((s) => s.selectedStashHash);
  const stashes = useStore((s) => s.stashes);
  const files = useStore((s) => s.commitFiles);
  const loading = useStore((s) => s.loadingCommitFiles);
  const selectStash = useStore((s) => s.selectStash);
  const saveStashNote = useStore((s) => s.saveStashNote);
  const openFile = useStore((s) => s.openFile);
  const selectedFile = useStore((s) => s.selectedFile);
  const pop = useStore((s) => s.stashPop);
  const apply = useStore((s) => s.stashApply);
  const drop = useStore((s) => s.stashDrop);
  const remoteBusy = useStore((s) => s.remoteBusy);
  const requestConfirm = useStore((s) => s.requestConfirm);

  const stash = stashes.find((s) => s.hash === hash);

  if (!stash) return null;

  const isActive = (f: CommitFile) =>
    selectedFile?.source === "commit" &&
    selectedFile.hash === stash.hash &&
    selectedFile.path === f.path;

  const open = (f: CommitFile) =>
    openFile({
      path: f.path,
      oldPath: f.oldPath,
      source: "commit",
      hash: stash.hash,
      status: f.status,
    });

  const onDrop = async () => {
    const ok = await requestConfirm(
      `This is a destructive operation, are you sure you want to drop ${stash.ref}?`,
      "Drop",
    );
    if (ok) drop(stash.index);
  };

  return (
    <div className="commit-details stash-details">
      <div className="cd-header">
        <span className="cd-title-label">Stash</span>
        <span className="cd-hash">{stash.ref}</span>
        <div className="spacer" />
        <button className="icon-btn" title="Back to changes" onClick={() => selectStash(null)}>
          ✕
        </button>
      </div>

      <StashNote key={stash.hash} stash={stash} onSave={saveStashNote} />

      <div className="sd-actions">
        <button
          className="sd-btn primary"
          disabled={remoteBusy}
          onClick={() => pop(stash.index)}
          title="Apply these changes and remove the stash"
        >
          <IconPop width={14} height={14} /> Pop
        </button>
        <button
          className="sd-btn"
          disabled={remoteBusy}
          onClick={() => apply(stash.index)}
          title="Apply these changes and keep the stash"
        >
          Apply
        </button>
        <div className="spacer" />
        <button className="sd-btn danger" disabled={remoteBusy} onClick={onDrop} title="Delete this stash">
          Drop
        </button>
      </div>

      <div className="cd-meta">
        <div className="cd-meta-row">
          <span className="cd-meta-key">Stashed</span>
          <span className="cd-meta-val">{formatDate(stash.date)}</span>
        </div>
        <div className="cd-meta-row">
          <span className="cd-meta-key">Label</span>
          <span className="cd-meta-val">{stash.message}</span>
        </div>
        <div className="cd-meta-row">
          <span className="cd-meta-key">Commit</span>
          <span className="cd-meta-val cd-mono">{stash.hash}</span>
        </div>
      </div>

      <ChangedFiles files={files} loading={loading} isActive={isActive} onOpen={open} />
    </div>
  );
}

/**
 * The editable note. Kept as a draft until saved so a half-typed thought is
 * never written to the repo, and remounted per stash (via key) so switching
 * stashes can't carry one stash's draft over to another.
 */
function StashNote({
  stash,
  onSave,
}: {
  stash: StashEntry;
  onSave: (hash: string, title: string, description: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(stash.noteTitle);
  const [body, setBody] = useState(stash.noteBody);
  const [saving, setSaving] = useState(false);

  const dirty = title !== stash.noteTitle || body !== stash.noteBody;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    // git stores the note trimmed; match it locally so the draft settles clean.
    const [t, b] = [title.trim(), body.trim()];
    try {
      await onSave(stash.hash, t, b);
      setTitle(t);
      setBody(b);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sd-note">
      <input
        className="sd-note-title"
        value={title}
        placeholder={stash.message || "Name this stash"}
        aria-label="Stash title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      <textarea
        className="sd-note-body"
        value={body}
        placeholder="Notes — what's in here, and what to do with it"
        aria-label="Stash description"
        rows={3}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && save()}
      />
      <div className="sd-note-foot">
        <span className="sd-note-hint">
          {dirty ? "Unsaved" : title || body ? "Saved as a git note" : "Kept as a git note"}
        </span>
        <button className="sd-btn" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save note"}
        </button>
      </div>
    </div>
  );
}

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
