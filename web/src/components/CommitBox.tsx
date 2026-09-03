import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useStore } from "../state/store";
import { BusyLabel, IconChevron, IconCommit, IconPush, IconSparkle, IconSpinner } from "./icons";
import "./CommitBox.css";

const SUMMARY_LIMIT = 72;

export interface AiCommitControls {
  generate: () => void;
  generating: boolean;
  disabled: boolean;
  label: string;
}

export function CommitBox({ children }: { children?: (ai: AiCommitControls) => ReactNode }) {
  const status = useStore((s) => s.status);
  const committing = useStore((s) => s.committing);
  const commit = useStore((s) => s.commit);
  const setNotice = useStore((s) => s.setNotice);
  const commits = useStore((s) => s.commits);
  const repo = useStore((s) => s.repo);
  const activeTabId = useStore((s) => s.activeTabId);
  const opening = useStore((s) => s.opening);
  const openAiCommitDialog = useStore((s) => s.openAiCommitDialog);
  const setError = useStore((s) => s.setError);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const generation = useRef<AbortController | null>(null);

  const cancelGeneration = () => {
    generation.current?.abort();
    generation.current = null;
    setGenerating(false);
  };

  useEffect(() => {
    cancelGeneration();
    return () => generation.current?.abort();
  }, [activeTabId, repo?.root, repo?.branch, repo?.head]);

  // The draft the user had typed before enabling amend, restored on un-amend.
  const preAmendDraft = useRef<{ title: string; description: string } | null>(null);

  // The commit amend would rewrite: the one at HEAD.
  // Match the repository metadata exactly: during a checkout the previous
  // commit list can remain rendered until the refreshed list arrives, and its
  // old isHead decoration must not be offered as the new branch's amend target.
  const headCommit = repo?.head ? commits.find((c) => c.hash === repo.head) ?? null : null;

  // An amend draft belongs to the exact HEAD it was loaded from. If checkout,
  // pull, reset, or another operation moves HEAD, leave amend mode and restore
  // the ordinary draft rather than offering to rewrite a different commit with
  // the stale message. App keys this component by repo root, so changing repos
  // resets every local draft synchronously as well.
  useEffect(() => {
    if (!amend) return;
    const draft = preAmendDraft.current;
    preAmendDraft.current = null;
    setAmend(false);
    setTitle(draft?.title ?? "");
    setDescription(draft?.description ?? "");
  }, [repo?.branch, repo?.head]);

  const stagedCount = status.staged.length;
  const canCommit = (stagedCount > 0 || amend) && title.trim().length > 0 && !committing && !generating;
  const aiDisabled = opening || committing || generating || (!amend && stagedCount + status.unstaged.length === 0);
  const aiLabel = generating ? "Generating commit information…"
    : amend ? "Generate title and description for the amended commit"
    : `Generate title and description from ${stagedCount > 0 ? "staged" : "unstaged"} changes`;

  const generate = async () => {
    if (aiDisabled || generation.current) return;
    const controller = new AbortController();
    generation.current = controller;
    setGenerating(true);
    const isCurrent = () => {
      const current = useStore.getState();
      return !controller.signal.aborted && current.activeTabId === activeTabId
        && current.repo?.root === repo?.root && current.repo?.head === repo?.head
        && current.repo?.branch === repo?.branch;
    };
    try {
      const info = await api.aiCommitInfo(controller.signal);
      if (!isCurrent()) return;
      if (!info.configured) {
        openAiCommitDialog();
        return;
      }
      const message = await api.generateAiCommitInfo(amend, controller.signal);
      if (!isCurrent()) return;
      setTitle(message.title);
      setDescription(message.description);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't generate commit information.");
    } finally {
      if (generation.current === controller) {
        generation.current = null;
        setGenerating(false);
      }
    }
  };

  // Checking amend prefills the fields with the previous commit's message (and
  // stashes any current draft); unchecking restores that draft.
  const toggleAmend = (checked: boolean) => {
    cancelGeneration();
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
    <>
      {children?.({ generate, generating, disabled: aiDisabled, label: aiLabel })}
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
          <input
            type="checkbox"
            checked={amend}
            disabled={!headCommit || committing || generating}
            onChange={(e) => toggleAmend(e.target.checked)}
          />
          Amend previous commit
        </label>

        <div className="summary-field">
          <input
            className="summary-input"
            placeholder="Commit summary"
            maxLength={SUMMARY_LIMIT}
            value={title}
            onChange={(e) => {
              cancelGeneration();
              setTitle(e.target.value);
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doCommit();
            }}
          />
          <span className="summary-count">{SUMMARY_LIMIT - title.length}</span>
          <button className="summary-ai" title={aiLabel} disabled={aiDisabled} onClick={() => void generate()}>
            {generating ? <IconSpinner width={14} height={14} /> : <IconSparkle width={14} height={14} />}
          </button>
        </div>

        <textarea
          className="desc-input"
          placeholder="Description"
          rows={3}
          value={description}
          onChange={(e) => {
            cancelGeneration();
            setDescription(e.target.value);
          }}
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

        <button className="compose-ai" title={aiLabel} disabled={aiDisabled} onClick={() => void generate()}>
          {generating ? <BusyLabel>Generating commit information…</BusyLabel>
            : <><IconSparkle width={14} height={14} /> Compose commits with AI</>}
        </button>

        <button className="commit-submit" disabled={!canCommit} onClick={doCommit}>
          <IconCommit width={15} height={15} /> {buttonLabel}
        </button>
      </div>
    </>
  );
}
