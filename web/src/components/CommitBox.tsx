import { useRef, useState } from "react";
import { useStore } from "../state/store";
import { BusyLabel, IconChevron, IconCommit, IconPush, IconSparkle } from "./icons";
import "./CommitBox.css";

const SUMMARY_LIMIT = 72;

export function CommitBox() {
  const status = useStore((s) => s.status);
  const committing = useStore((s) => s.committing);
  const commit = useStore((s) => s.commit);
  const setNotice = useStore((s) => s.setNotice);
  const commits = useStore((s) => s.commits);
  const repo = useStore((s) => s.repo);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  // The draft the user had typed before enabling amend, restored on un-amend.
  const preAmendDraft = useRef<{ title: string; description: string } | null>(null);

  // The commit amend would rewrite: the one at HEAD.
  const headCommit =
    commits.find((c) => c.refs.some((r) => r.isHead)) ??
    (repo?.head ? commits.find((c) => c.hash === repo.head) : undefined) ??
    null;

  const stagedCount = status.staged.length;
  const canCommit = (stagedCount > 0 || amend) && title.trim().length > 0 && !committing;

  // Checking amend prefills the fields with the previous commit's message (and
  // stashes any current draft); unchecking restores that draft.
  const toggleAmend = (checked: boolean) => {
    setAmend(checked);
    if (checked) {
      preAmendDraft.current = { title, description };
      if (headCommit) {
        setTitle(headCommit.subject);
        setDescription(headCommit.body);
      }
    } else {
      const draft = preAmendDraft.current;
      preAmendDraft.current = null;
      setTitle(draft?.title ?? "");
      setDescription(draft?.description ?? "");
    }
  };

  const doCommit = async () => {
    if (!canCommit) return;
    try {
      await commit(title, description, amend);
      setTitle("");
      setDescription("");
      setAmend(false);
      preAmendDraft.current = null;
    } catch {
      /* surfaced via store */
    }
  };

  // Hooks can make a commit take a moment, so it gets the same wait treatment.
  const buttonLabel = committing
    ? <BusyLabel>Committing…</BusyLabel>
    : stagedCount > 0 || amend
      ? `Commit ${stagedCount} file${stagedCount === 1 ? "" : "s"}${amend ? " (amend)" : ""}`
      : "Stage Changes to Commit";

  return (
    <div className="commit-box">
      <div className="commit-box-head">
        <span className="commit-box-title">
          <IconCommit width={15} height={15} /> Commit
        </span>
        <div className="commit-box-actions">
          <button title="Commit and push (coming soon)" onClick={() => setNotice("Commit & push isn't available yet.")}>
            <IconPush width={15} height={15} />
          </button>
          <button title="Commit and sync (coming soon)" onClick={() => setNotice("Commit & sync isn't available yet.")}>
            <IconSparkle width={15} height={15} />
          </button>
        </div>
      </div>

      <label className="amend-row">
        <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} />
        Amend previous commit
      </label>

      <div className="summary-field">
        <input
          className="summary-input"
          placeholder="Commit summary"
          maxLength={SUMMARY_LIMIT}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doCommit();
          }}
        />
        <span className="summary-count">{SUMMARY_LIMIT - title.length}</span>
        <button className="summary-ai" title="Generate summary (coming soon)" onClick={() => setNotice("AI summary isn't available yet.")}>
          <IconSparkle width={14} height={14} />
        </button>
      </div>

      <textarea
        className="desc-input"
        placeholder="Description"
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doCommit();
        }}
      />

      <button className="commit-options" onClick={() => setOptionsOpen((v) => !v)}>
        <IconChevron
          width={11}
          height={11}
          style={{ transform: optionsOpen ? "rotate(90deg)" : "none", transition: "transform .12s" }}
        />
        Commit options
      </button>
      {optionsOpen && (
        <div className="commit-options-body">
          Additional commit options (sign-off, GPG signing) are coming later.
        </div>
      )}

      <button className="compose-ai" onClick={() => setNotice("AI commit composition isn't available yet.")}>
        <IconSparkle width={14} height={14} /> Compose commits with AI
      </button>

      <button className="commit-submit" disabled={!canCommit} onClick={doCommit}>
        <IconCommit width={15} height={15} /> {buttonLabel}
      </button>
    </div>
  );
}
