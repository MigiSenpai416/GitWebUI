import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { api } from "../api/client";
import type { GitHubAccount, GitHubLabel, PrContext, PrMeta } from "../types";
import { BusyLabel, IconCaretDown, IconClose, IconPullRequest } from "./icons";
import "./AccountDialogs.css";
import "./PullRequestDialog.css";

const EMPTY_META: PrMeta = { collaborators: [], assignees: [], labels: [] };

/**
 * Open a pull request on GitHub for the chosen branch. The dialog loads its own
 * context (GitHub remotes, fork parents, local branches, PR templates) and only
 * goes through the store for the mutating create — which also handles the
 * "push this branch first" prompt.
 */
export function PullRequestDialog() {
  const open = useStore((s) => s.prDialogOpen);
  const close = useStore((s) => s.closePullRequest);
  const headBranchHint = useStore((s) => s.prHeadBranch);
  const commits = useStore((s) => s.commits);
  const githubStatus = useStore((s) => s.githubStatus);
  const openGitHubDialog = useStore((s) => s.openGitHubDialog);
  const openAddRemote = useStore((s) => s.openAddRemote);
  const ensureBranchPushed = useStore((s) => s.ensureBranchPushed);
  const createPullRequest = useStore((s) => s.createPullRequest);

  const [ctx, setCtx] = useState<PrContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [headRepo, setHeadRepo] = useState("");
  const [headBranch, setHeadBranch] = useState("");
  const [baseRepo, setBaseRepo] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [baseBranches, setBaseBranches] = useState<string[]>([]);
  const [meta, setMeta] = useState<PrMeta>(EMPTY_META);

  const [templatePath, setTemplatePath] = useState("");
  /** The template text currently in the description, so we never clobber edits. */
  const [appliedTemplate, setAppliedTemplate] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const connected = Boolean(githubStatus?.user);

  // Load the dialog's context once per open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .prContext()
      .then((data) => {
        if (cancelled) return;
        setCtx(data);
        const head = headBranchHint ?? data.head.branch;
        setHeadRepo(data.head.repo?.fullName ?? "");
        setHeadBranch(head);
        setBaseRepo(data.defaults.baseRepo ?? "");
        setBaseBranch(data.defaults.baseBranch ?? "");
        setTitle(defaultTitle(commits, head));
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load repositories.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `commits` is only read for the initial title — deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, headBranchHint]);

  // Target repo drives the base-branch list and the reviewer/label options.
  useEffect(() => {
    if (!open || !baseRepo) return;
    let cancelled = false;
    setReviewers([]);
    setAssignees([]);
    setLabels([]);
    api
      .prBranches(baseRepo)
      .then(({ branches }) => {
        if (cancelled) return;
        setBaseBranches(branches);
        setBaseBranch((cur) => {
          if (cur && branches.includes(cur)) return cur;
          const target = ctx?.baseCandidates.find((r) => r.fullName === baseRepo);
          return target?.defaultBranch ?? branches[0] ?? cur;
        });
      })
      .catch(() => {
        if (!cancelled) setBaseBranches([]);
      });
    api
      .prMeta(baseRepo)
      .then((m) => !cancelled && setMeta(m))
      .catch(() => !cancelled && setMeta(EMPTY_META));
    return () => {
      cancelled = true;
    };
  }, [open, baseRepo, ctx]);

  // Reset everything when the dialog closes so the next open starts clean.
  useEffect(() => {
    if (open) return;
    setCtx(null);
    setTemplatePath("");
    setAppliedTemplate("");
    setTitle("");
    setBody("");
    setDraft(false);
    setReviewers([]);
    setAssignees([]);
    setLabels([]);
    setMeta(EMPTY_META);
    setBaseBranches([]);
    setError(null);
    setHint(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, close]);

  const headBranches = useMemo(
    () => (ctx?.head.branches ?? []).map((b) => b.name),
    [ctx],
  );

  if (!open) return null;

  const pickTemplate = async (path: string) => {
    setHint(null);
    setTemplatePath(path);
    if (!path) {
      // Clearing only drops text the template itself put there.
      if (body === appliedTemplate) setBody("");
      setAppliedTemplate("");
      return;
    }
    try {
      const { body: text } = await api.prTemplate(path);
      if (body.trim() === "" || body === appliedTemplate) {
        setBody(text);
        setAppliedTemplate(text);
      } else {
        setHint("Kept your description — clear it to use the template.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the template.");
    }
  };

  const submit = async () => {
    setError(null);
    setHint(null);
    if (!headRepo || !baseRepo) {
      setError("Pick the source and target repositories.");
      return;
    }
    if (!title.trim()) {
      setError("Enter a title for the pull request.");
      return;
    }
    if (headRepo === baseRepo && headBranch === baseBranch) {
      setError("The source and target branches are the same.");
      return;
    }
    setBusy(true);
    try {
      const check = await ensureBranchPushed(headBranch);
      if (!check.ok) {
        if (check.reason) setError(check.reason);
        return;
      }
      await createPullRequest({
        baseRepo,
        base: baseBranch,
        headRepo,
        head: headBranch,
        title: title.trim(),
        body,
        draft,
        reviewers,
        assignees,
        labels,
      });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the pull request.");
    } finally {
      setBusy(false);
    }
  };

  const noRemote = Boolean(ctx) && ctx!.baseCandidates.length === 0;
  const fromOptions = ctx?.head.repo ? [ctx.head.repo] : [];

  return (
    <div className="dialog-backdrop" onMouseDown={busy ? undefined : close}>
      <div className="dialog pr-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="acct-head">
          <IconPullRequest width={18} height={18} className="acct-gh-logo" />
          <div className="dialog-title">Create Pull Request</div>
          <button className="acct-x" onClick={close} aria-label="Close" disabled={busy}>
            ✕
          </button>
        </div>

        {!connected ? (
          <div className="acct-connect">
            <p>Connect a GitHub account to open pull requests.</p>
            <button className="dialog-btn dialog-btn-primary" onClick={openGitHubDialog}>
              Connect GitHub account
            </button>
          </div>
        ) : loading ? (
          <div className="pr-loading">Loading repositories…</div>
        ) : loadError ? (
          <div className="acct-error">{loadError}</div>
        ) : noRemote ? (
          <div className="acct-connect">
            <p>This repository has no GitHub remote to open a pull request against.</p>
            <button className="dialog-btn dialog-btn-primary" onClick={openAddRemote}>
              Add a remote
            </button>
          </div>
        ) : (
          <>
            <div className="pr-repos">
              <Field label="From Repo">
                <select
                  value={headRepo}
                  onChange={(e) => setHeadRepo(e.target.value)}
                  disabled={busy || fromOptions.length < 2}
                >
                  {fromOptions.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="pr-arrow" aria-hidden>
                →
              </div>
              <Field label="To Repo">
                <select
                  value={baseRepo}
                  onChange={(e) => setBaseRepo(e.target.value)}
                  disabled={busy}
                >
                  {(ctx?.baseCandidates ?? []).map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Branch">
                <select
                  value={headBranch}
                  onChange={(e) => setHeadBranch(e.target.value)}
                  disabled={busy}
                >
                  {headBranches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="pr-arrow" aria-hidden>
                →
              </div>
              <Field label="Branch">
                <select
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  disabled={busy || baseBranches.length === 0}
                >
                  {baseBranches.length === 0 && <option value={baseBranch}>{baseBranch}</option>}
                  {baseBranches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {(ctx?.templates.length ?? 0) > 0 && (
              <div className="acct-field">
                <span>Template</span>
                <div className="pr-template-row">
                  <select
                    value={templatePath}
                    onChange={(e) => pickTemplate(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">No template</option>
                    {ctx!.templates.map((t) => (
                      <option key={t.path} value={t.path}>
                        {t.path}
                      </option>
                    ))}
                  </select>
                  {templatePath && (
                    <button
                      className="pr-template-clear"
                      title="Clear template"
                      onClick={() => pickTemplate("")}
                      disabled={busy}
                    >
                      <IconClose width={13} height={13} />
                    </button>
                  )}
                </div>
              </div>
            )}

            <label className="acct-field">
              <span>Title</span>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Summarize the change"
                disabled={busy}
              />
            </label>

            <label className="acct-field">
              <span>Description</span>
              <textarea
                className="pr-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Optional"
                rows={6}
                disabled={busy}
              />
            </label>

            <div className="acct-field">
              <span>Reviewers</span>
              <MultiSelect
                placeholder="Add reviewers…"
                options={accountOptions(meta.collaborators)}
                selected={reviewers}
                onChange={setReviewers}
                disabled={busy}
              />
            </div>
            <div className="acct-field">
              <span>Assignees</span>
              <MultiSelect
                placeholder="Add assignees…"
                options={accountOptions(meta.assignees)}
                selected={assignees}
                onChange={setAssignees}
                disabled={busy}
              />
            </div>
            <div className="acct-field">
              <span>Labels</span>
              <MultiSelect
                placeholder="Add labels…"
                options={labelOptions(meta.labels)}
                selected={labels}
                onChange={setLabels}
                disabled={busy}
              />
            </div>

            <label className="pr-draft">
              <input
                type="checkbox"
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
                disabled={busy}
              />
              Submit as draft
            </label>

            {hint && <div className="pr-hint">{hint}</div>}
            {error && <div className="acct-error">{error}</div>}

            <div className="dialog-actions">
              <button className="dialog-btn" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button className="dialog-btn dialog-btn-primary" onClick={submit} disabled={busy}>
                {busy ? <BusyLabel>Creating…</BusyLabel> : "Create Pull Request"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="pr-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

interface Option {
  value: string;
  label: string;
  /** Hex color (no #) rendered as a swatch — used for labels. */
  color?: string;
}

function accountOptions(accounts: GitHubAccount[]): Option[] {
  return accounts.map((a) => ({ value: a.login, label: a.login }));
}

function labelOptions(labels: GitHubLabel[]): Option[] {
  return labels.map((l) => ({ value: l.name, label: l.name, color: l.color }));
}

/**
 * Seed the title from the newest commit that carries the head branch's ref —
 * what GitHub itself proposes for a single-commit branch.
 */
function defaultTitle(commits: { subject: string; refs: { name: string; kind: string }[] }[], branch: string): string {
  const tip = commits.find((c) => c.refs.some((r) => r.kind === "branch" && r.name === branch));
  return tip?.subject ?? "";
}

interface MultiSelectProps {
  placeholder: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

/** Compact chips + checkbox popover, used for reviewers, assignees, and labels. */
function MultiSelect({ placeholder, options, selected, onChange, disabled }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  return (
    <div className="pr-multi" ref={ref}>
      <button
        type="button"
        className="pr-multi-btn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pr-multi-value">
          {selected.length === 0 ? (
            <span className="pr-multi-placeholder">{placeholder}</span>
          ) : (
            selected.map((v) => (
              <span className="pr-chip" key={v}>
                {v}
              </span>
            ))
          )}
        </span>
        <IconCaretDown className="pr-multi-caret" width={14} height={14} />
      </button>
      {open && (
        <div className="pr-multi-menu">
          {options.length === 0 ? (
            <div className="pr-multi-empty">None available</div>
          ) : (
            options.map((o) => (
              <label className="pr-multi-item" key={o.value}>
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={() => toggle(o.value)}
                />
                {o.color && <span className="pr-swatch" style={{ background: `#${o.color}` }} />}
                <span className="pr-multi-label">{o.label}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
