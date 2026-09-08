import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { api } from "../api/client";
import { openExternal } from "../desktop";
import { useStore, type ToastItem } from "../state/store";
import { Toast } from "./ToastStack";
import { activityKey, buildConversation } from "./prConversation";
import { PrFilePatch, type PrLineComment } from "./PrFilePatch";
import type { PrActivity, PrChecks, PullRequestDetails } from "../types";
import { BusyLabel, IconPullRequest, IconRefresh, IconExternal, IconCommit, IconEye, IconBranch } from "./icons";
import "./AccountDialogs.css";

export function PullRequestViewer({ repo, number, onClose, onChanged }: {
  repo: string; number: number; onClose: () => void; onChanged: () => void;
}) {
  const [pr, setPr] = useState<PullRequestDetails | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<ToastItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState("comments");
  const [message, setMessage] = useState("");
  const [event, setEvent] = useState("COMMENT");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [formRevision, setFormRevision] = useState(0);
  const [reviewMessage, setReviewMessage] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({});
  const [lineDrafts, setLineDrafts] = useState<Record<string, string>>({});
  const [method, setMethod] = useState("squash");
  const [customizeMerge, setCustomizeMerge] = useState(false);
  const [mergeDrafts, setMergeDrafts] = useState<Record<string, { title: string; body: string }>>({});
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const confirm = useStore((s) => s.requestConfirm);
  const root = useStore((s) => s.repo?.root);
  const login = useStore((s) => s.githubStatus?.user?.login);

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { alive.current = false; previous?.focus(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api.prDetails(repo, number, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setPr(data);
      setMethod((v) => data.mergeMethods.includes(v) ? v : data.mergeMethods[0] ?? "merge");
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [repo, number, revision]);

  useEffect(() => {
    const selector = tab === "files" && reviewOpen ? ".prv-review-form textarea" : tab === "comments" && editing ? ".prv-edit input" : null;
    if (!selector) return;
    const frame = requestAnimationFrame(() => {
      const input = ref.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      input?.parentElement?.scrollIntoView({ block: "start" });
      input?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [tab, reviewOpen, editing, formRevision]);

  const act = async (input: Record<string, unknown>, confirmation?: string) => {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    setNotice(null);
    try {
      if (confirmation && !await confirm(confirmation, "Confirm")) return;
      if (!alive.current || useStore.getState().repo?.root !== root || useStore.getState().githubStatus?.user?.login !== login) return;
      await api.prAction(repo, number, input);
      if (!alive.current) return;
      if (input.action === "comment") setMessage("");
      if (input.action === "review") { setReviewMessage(""); setReviewOpen(false); setTab("comments"); }
      setEditing(false);
      setNotice({ id: Date.now(), seq: Date.now(), kind: "notice", message: "Pull request updated." });
      setRevision((v) => v + 1);
      onChanged();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Couldn't update the pull request.");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const reply = async (commentId: number, body: string) => {
    if (busy || loading || useStore.getState().repo?.root !== root || useStore.getState().githubStatus?.user?.login !== login) throw new Error("The pull request is not ready. Try again.");
    setBusy(true);
    try {
      const result = await api.prReply(repo, number, commentId, body);
      if (alive.current) {
        setReplyDrafts((prev) => ({ ...prev, [commentId]: "" }));
        setNotice({ id: Date.now(), seq: Date.now(), kind: "notice", message: "Reply posted." });
      }
      return result.reply;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const codeComment = async (comment: PrLineComment) => {
    if (busy || loading || !pr || useStore.getState().repo?.root !== root || useStore.getState().githubStatus?.user?.login !== login) throw new Error("The pull request is not ready. Try again.");
    setBusy(true);
    try {
      await api.prAction(repo, number, { action: "code-comment", ...comment, sha: pr.sha });
      if (alive.current) setNotice({ id: Date.now(), seq: Date.now(), kind: "notice", message: "Code comment posted." });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const mergeReady = pr?.state === "open" && !pr.draft && pr.mergeable === true
    && ["clean", "unstable", "has_hooks"].includes(pr.mergeableState);
  const mergeDraft = mergeDrafts[method] ?? { title: pr?.title ?? "", body: "" };
  const customMerge = customizeMerge && method !== "rebase";

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div ref={ref} className="dialog prv-dialog" role="dialog" aria-modal="true" aria-label={`Pull request #${number}`} tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); if (!busy) onClose(); }
          if (e.key === "Tab") {
            const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]") ?? [])
              .filter((el) => el.getClientRects().length > 0);
            const first = nodes[0]; const last = nodes[nodes.length - 1];
            if (!first) { e.preventDefault(); return; }
            if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          }
        }}>
        <div className="acct-head">
          <div className="prv-heading">
            <div className="prv-repo">{repo} · #{number}</div>
            <div className="prv-title-row">
              <IconPullRequest width={18} height={18} className={`prs-${pr?.draft ? "draft" : pr?.state ?? "open"}`} />
              <div className="dialog-title">{pr?.title ?? "Pull Request"}</div>
            </div>
          </div>
          <button className="icon-btn" title="Refresh pull request" aria-label="Refresh" disabled={busy || loading} onClick={() => setRevision((v) => v + 1)}><IconRefresh width={16} height={16} /></button>
          <button className="dialog-btn prv-external" onClick={() => openExternal(`https://github.com/${repo}/pull/${number}`)}>Open in GitHub <IconExternal width={13} height={13} /></button>
          <button className="acct-x" aria-label="Close pull request dialog" disabled={busy} onClick={onClose}>✕</button>
        </div>
        {error && <div className="acct-error" role="alert">{error}</div>}
        {loading && <div className="prv-loading">Loading pull request…</div>}
        {pr && <>
          <div className="prv-meta">
            <span className={`prv-badge prs-${pr.state}`}>{pr.state === "open" && pr.draft ? "Draft" : pr.state}</span>
            <span className="prv-branches">
              <strong>{pr.author}</strong> {pr.state === "merged" ? "merged" : pr.state === "closed" ? "wanted to merge" : "wants to merge"} {pr.commits} {pr.commits === 1 ? "commit" : "commits"} into <span className="prv-branch" title="Target branch">{pr.base}</span> from <span className="prv-branch" title="Source branch">{pr.head}</span>
            </span>
          </div>
          <div className="prv-tabbar">
          <div className="prv-tabs" role="tablist" aria-label="Pull request information">
            {[["comments", "Conversation"], ["commits", `Commits (${pr.commits})`], ["checks", "Checks"], ["files", `Files changed (${pr.changedFiles})`]].map(([id, label]) =>
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} disabled={busy} onClick={() => setTab(id)}>{label}</button>)}
          </div>
          </div>
          <div className="prv-layout">
            <div className="prv-scroll">
              {tab === "comments" && <section className="prv-description">
                <div className="prv-comment-head"><strong>{pr.author}</strong><span>opened this pull request</span><span className="prv-label">Author</span></div>
                {editing ? <div className="prv-edit">
                  <label className="acct-field">Title<input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} /></label>
                  <label className="acct-field">Description<textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} /></label>
                  <button className="dialog-btn dialog-btn-primary" disabled={busy || loading || !title.trim()} onClick={() => act({ action: "edit", title, body })}>Save changes</button>
                  <button className="dialog-btn" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
                </div> : <>
                  <PrMarkdown text={pr.body || "No description provided."} baseUrl={`https://github.com/${repo}/pull/${number}`} />
                </>}
              </section>}
            {tab === "files" && reviewOpen && pr.canReview && <section className="prv-review-form" aria-label="Review changes">
              <div className="prv-section-title">Finish your review</div>
              <textarea aria-label="Review summary" placeholder="Leave a review summary…" rows={4} value={reviewMessage} onChange={(e) => setReviewMessage(e.target.value)} disabled={busy} />
              <fieldset disabled={busy}>
                <legend>Review decision</legend>
                {[["COMMENT", "Comment", "Submit general feedback without explicit approval."], ["APPROVE", "Approve", "Submit feedback and approve merging these changes."], ["REQUEST_CHANGES", "Request changes", "Suggest changes that should be addressed before merging."]].map(([value, label, help]) =>
                  <label key={value}><input type="radio" name="pr-review-decision" value={value} checked={event === value} onChange={() => setEvent(value)} /><span><strong>{label}</strong><small>{help}</small></span></label>)}
              </fieldset>
              <button className="dialog-btn dialog-btn-primary" disabled={busy || loading || (event !== "APPROVE" && !reviewMessage.trim())} onClick={() => act({ action: "review", event, body: reviewMessage, sha: pr.sha }, `Submit this review on ${repo} #${number}?`)}>Submit review</button>
            </section>}
            {tab === "comments" ? <PrConversation key={revision} repo={repo} number={number} canReply={pr.canComment} busy={busy || loading}
              drafts={replyDrafts} onDraft={(id, text) => setReplyDrafts((prev) => ({ ...prev, [id]: text }))} onReply={reply} />
              : <PrActivityPanel key={`${tab}:${revision}`} repo={repo} number={number} tab={tab} sha={pr.sha} canComment={pr.canComment && pr.state === "open"} busy={busy || loading} onComment={codeComment}
                drafts={lineDrafts} onDraft={(path, body) => setLineDrafts((prev) => ({ ...prev, [path]: body }))} total={tab === "files" ? pr.changedFiles : tab === "commits" ? pr.commits : undefined} />}
            {tab === "comments" && (
            <div className="prv-management">
              <div className="prv-section-title">{pr.state === "open" ? "Merge pull request" : "Pull request status"}</div>
              <span>{pr.state === "open" ? pr.draft ? "Draft — mark ready for review on GitHub." : pr.mergeable === null ? "GitHub is calculating mergeability. Refresh to check again."
                : pr.mergeable === false ? "Conflicts must be resolved before merging." : `Merge status: ${pr.mergeableState}. GitHub enforces branch rules.` : `This pull request is ${pr.state}.`}</span>
              {pr.canEdit && pr.state !== "merged" && <button className="dialog-btn" disabled={busy || loading} onClick={() => act({ action: pr.state === "open" ? "close" : "reopen" }, `${pr.state === "open" ? "Close" : "Reopen"} ${repo} #${number}?`)}>{pr.state === "open" ? "Close PR" : "Reopen PR"}</button>}
              {pr.canMerge && pr.state === "open" && <>
                <select aria-label="Merge method" value={method} disabled={busy || !mergeReady} onChange={(e) => setMethod(e.target.value)}>
                  {pr.mergeMethods.map((m) => <option key={m} value={m}>{m === "squash" ? "Squash and merge" : m === "rebase" ? "Rebase and merge" : "Create merge commit"}</option>)}
                </select>
                {method !== "rebase" ? <div className="prv-merge-message">
                  <label><input type="checkbox" checked={customizeMerge} disabled={busy || loading} onChange={(e) => {
                    setCustomizeMerge(e.target.checked);
                    if (e.target.checked) setMergeDrafts((prev) => ({ ...prev, [method]: mergeDraft }));
                  }} /> Customize commit message</label>
                  {customMerge ? <>
                    <label className="acct-field">Commit title<input aria-label="Merge commit title" value={mergeDraft.title} disabled={busy || loading} onChange={(e) => setMergeDrafts((prev) => ({ ...prev, [method]: { ...mergeDraft, title: e.target.value } }))} /></label>
                    <label className="acct-field">Commit description<textarea aria-label="Merge commit description" rows={4} value={mergeDraft.body} disabled={busy || loading} placeholder="Optional description" onChange={(e) => setMergeDrafts((prev) => ({ ...prev, [method]: { ...mergeDraft, body: e.target.value } }))} /></label>
                  </> : <p className="prv-muted">GitHub will use the repository’s default commit message.</p>}
                </div> : <span>Rebase preserves the individual commit messages.</span>}
                <button className="dialog-btn dialog-btn-primary" disabled={busy || loading || !mergeReady || !pr.mergeMethods.length || (customMerge && !mergeDraft.title.trim())} onClick={() => act({ action: "merge", method, sha: pr.sha, ...(customMerge ? { commitTitle: mergeDraft.title, commitMessage: mergeDraft.body } : {}) }, `Merge ${repo} #${number} into ${pr.base} using ${method}? This changes the remote repository.`)}>Merge PR</button>
              </>}
            </div>
            )}
            {pr.canComment && tab === "comments" && <div className="prv-compose">
              <div className="prv-section-title">Join the conversation</div>
              <textarea aria-label="Comment or review" placeholder="Leave your feedback…" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy} />
              <div className="prv-compose-actions">
                <button className="dialog-btn dialog-btn-primary" disabled={busy || loading || !message.trim()} onClick={() => act({ action: "comment", body: message })}>{busy ? <BusyLabel>Sending…</BusyLabel> : "Comment"}</button>
              </div>
            </div>}
            </div>
            <aside className="prv-details" aria-label="Pull request details">
              <div className="prv-section-title">Details</div>
              <dl className="prv-facts">
                <dt>Assignees</dt><dd>{pr.assignees.length ? pr.assignees.map((name) => <span className="prv-person" key={name}><span className="prv-avatar">{name.slice(0, 1).toUpperCase()}</span>{name}</span>) : <span className="prv-muted">No assignees</span>}</dd>
                <dt>Reviewers requested</dt><dd>{[...pr.reviewers, ...pr.teams.map((t) => `Team: ${t}`)].join(", ") || <span className="prv-muted">None requested</span>}</dd>
                <dt>Labels</dt><dd>{pr.labels.length ? pr.labels.map((label) => <span className="prv-label" key={label}>{label}</span>) : <span className="prv-muted">No labels</span>}</dd>
                <dt>Changes</dt><dd>{pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"} <span className="prv-diff-stat"><span className="prs-open">+{pr.additions}</span> <span className="prs-closed">−{pr.deletions}</span></span></dd>
                <dt>Last updated</dt><dd>{new Date(pr.updatedAt).toLocaleString()}</dd>
              </dl>
              {pr.canEdit && <button className="dialog-btn prv-edit-button" disabled={busy || loading} onClick={() => { setTitle(pr.title); setBody(pr.body); setEditing(true); setTab("comments"); setFormRevision((v) => v + 1); }}>Edit title and description</button>}
              {tab === "files" && pr.canReview && <button className="dialog-btn dialog-btn-primary prv-review-toggle" aria-expanded={reviewOpen} onClick={() => { setReviewOpen((v) => !v); setFormRevision((v) => v + 1); }} disabled={busy || loading}>Review changes</button>}
            </aside>
          </div>
        </>}
        <div className="prv-notifications">
          {notice && <Toast key={notice.id} toast={notice} onClose={() => setNotice(null)} />}
        </div>
      </div>
    </div>, document.body,
  );
}

function PrMarkdown({ text, baseUrl }: { text: string; baseUrl: string }) {
  const openLink = (href: string) => {
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol === "https:" || url.protocol === "http:") openExternal(url.href);
    } catch {
      /* invalid Markdown URL */
    }
  };
  return <div className="prv-markdown"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={{
    a: ({ href, children }) => <a href={href} onClick={(e) => { e.preventDefault(); if (href) openLink(href); }}>{children}</a>,
    img: ({ alt, src }) => <button className="pr-link" onClick={() => { if (src) openLink(src); }}>View image{alt ? `: ${alt}` : ""}</button>,
  }}>{text}</Markdown></div>;
}

function PrComment({ item, baseUrl }: { item: PrActivity; baseUrl: string }) {
  return <div className="prv-comment">
    <div className="prv-comment-head">
      <strong>{item.user?.login ?? "ghost"}</strong><span>commented</span>
      {item.user?.type === "Bot" && <span className="prv-label">Bot</span>}
      {item.created_at && <time>{new Date(item.created_at).toLocaleString()}</time>}
      {item.author_association && !["NONE", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR"].includes(item.author_association) && <span className="prv-label">{item.author_association.toLowerCase()}</span>}
      {item.html_url && <button className="pr-link" onClick={() => openExternal(item.html_url!)}>Open on GitHub</button>}
    </div>
    <PrMarkdown text={item.body || "No message."} baseUrl={baseUrl} />
    {item.reactions && <div className="prv-reactions">{Object.entries({ "+1": "👍", "-1": "👎", laugh: "😄", hooray: "🎉", confused: "😕", heart: "❤️", rocket: "🚀", eyes: "👀" }).map(([name, emoji]) => Number(item.reactions?.[name]) > 0 && <span className="prv-label" key={name} title={name}>{emoji} {item.reactions![name]}</span>)}</div>}
  </div>;
}

function PrTimelineEvent({ item, baseUrl }: { item: PrActivity; baseUrl: string }) {
  const source = item.source?.issue;
  const commitRepo = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(?:git\/)?commits\//.exec(item.commit_url ?? "")?.[1];
  const labels: Record<string, string> = {
    ready_for_review: "marked this pull request as ready for review", convert_to_draft: "marked this pull request as draft",
    "cross-referenced": "mentioned this pull request", referenced: "referenced this pull request in a commit",
    head_ref_force_pushed: "force-pushed the head branch", head_ref_deleted: "deleted the head branch", head_ref_restored: "restored the head branch",
    base_ref_changed: "changed the base branch", closed: "closed this pull request", reopened: "reopened this pull request", merged: "merged this pull request",
    review_requested: "requested a review from", review_request_removed: "removed the review request for", review_dismissed: "dismissed a review",
    labeled: "added the label", unlabeled: "removed the label", assigned: "assigned", unassigned: "unassigned",
    milestoned: "added this to the milestone", demilestoned: "removed this from the milestone", renamed: "changed the title",
    locked: "locked this conversation", unlocked: "unlocked this conversation", connected: "linked this pull request", disconnected: "unlinked this pull request",
    auto_merge_enabled: "enabled auto-merge", auto_merge_disabled: "disabled auto-merge", deployed: "deployed these changes",
  };
  return <>
    <div className="prv-review-event">
      <strong>{item.actor?.login ?? item.user?.login ?? "ghost"}</strong>
      <span>{labels[item.event ?? ""] ?? item.event?.replaceAll("_", " ")}</span>
      {item.requested_reviewer && <strong>{item.requested_reviewer.login}</strong>}
      {item.requested_team && <strong>{item.requested_team.name ?? item.requested_team.slug}</strong>}
      {item.assignee && <strong>{item.assignee.login}</strong>}
      {item.label && <span className="prv-label">{item.label.name}</span>}
      {item.milestone && <strong>{item.milestone.title}</strong>}
      {item.rename && <span><del>{item.rename.from}</del> → <strong>{item.rename.to}</strong></span>}
      {item.created_at && <time>{new Date(item.created_at).toLocaleString()}</time>}
    </div>
    {source && <div className="prv-reference"><button className="pr-link" onClick={() => openExternal(source.html_url)}>{source.title} <span>#{source.number}</span></button><span className={`prv-badge prs-${source.draft ? "draft" : source.pull_request?.merged_at ? "merged" : source.state}`}>{source.draft ? "Draft" : source.pull_request?.merged_at ? "Merged" : source.state}</span></div>}
    {item.commit_id && <button className="pr-link prv-event-commit" onClick={() => openExternal(commitRepo ? `https://github.com/${commitRepo}/commit/${item.commit_id}` : `${baseUrl}/commits/${item.commit_id}`)}>{item.commit_id.slice(0, 7)}</button>}
    {item.dismissed_review?.dismissal_message && <PrMarkdown text={item.dismissed_review.dismissal_message} baseUrl={baseUrl} />}
  </>;
}

function PrCommitGroup({ items, repo }: { items: PrActivity[]; repo: string }) {
  return <>
    {items.length > 1 && <div className="prv-review-event"><strong>{items[0].user?.login ?? items[0].author?.name ?? "Contributor"}</strong><span>added {items.length} commits</span></div>}
    {items.map((item) => <div className="prv-timeline-commit" key={activityKey(item)}>
      <IconCommit width={16} height={16} />
      {item.user?.avatar_url && <img className="prv-commit-avatar" src={item.user.avatar_url} alt={item.user.login} title={item.user.login} />}
      <button className="pr-link" onClick={() => openExternal(item.html_url ?? `https://github.com/${repo}/commit/${item.sha}`)}>{item.message?.split("\n")[0] ?? item.sha}</button>
      {item.check_state && <span className={`prv-commit-check ${item.check_state === "SUCCESS" ? "prs-open" : ["FAILURE", "ERROR"].includes(item.check_state) ? "prs-closed" : "prv-muted"}`} title={`Checks: ${item.check_state.toLowerCase()}`} aria-label={`Checks: ${item.check_state.toLowerCase()}`}>{item.check_state === "SUCCESS" ? "✓" : ["FAILURE", "ERROR"].includes(item.check_state) ? "✕" : "●"}</span>}
      <button className="pr-link" onClick={() => openExternal(item.html_url ?? `https://github.com/${repo}/commit/${item.sha}`)}>{item.sha?.slice(0, 7)}</button>
    </div>)}
  </>;
}

function PrThreadReply({ commentId, draft, disabled, onDraft, onReply }: {
  commentId: number; draft: string; disabled: boolean; onDraft: (id: number, text: string) => void;
  onReply: (id: number, body: string) => Promise<void>;
}) {
  const [error, setError] = useState("");
  return <form className="prv-thread-reply" onSubmit={async (e) => {
    e.preventDefault();
    if (disabled || !draft.trim()) return;
    setError("");
    try { await onReply(commentId, draft); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't post the reply."); }
  }}>
    <textarea aria-label="Reply to code comment" placeholder="Reply…" rows={2} value={draft} onChange={(e) => onDraft(commentId, e.target.value)} disabled={disabled} />
    {error && <div className="acct-error" role="alert">{error}</div>}
    <button className="dialog-btn" type="submit" disabled={disabled || !draft.trim()}>Reply</button>
  </form>;
}

function PrConversation({ repo, number, canReply, busy, drafts, onDraft, onReply }: {
  repo: string; number: number; canReply: boolean; busy: boolean; drafts: Record<number, string>;
  onDraft: (id: number, text: string) => void; onReply: (id: number, body: string) => Promise<PrActivity>;
}) {
  const [data, setData] = useState<PrActivity[][]>([[], []]);
  const [threadStateError, setThreadStateError] = useState("");
  const [timelineWarning, setTimelineWarning] = useState("");
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const loadThreads = async () => {
      const items: PrActivity[] = [];
      for (let threadPage = 1; !controller.signal.aborted; threadPage++) {
        const result = await api.prActivity(repo, number, "threads", threadPage, controller.signal);
        items.push(...result.items);
        if (!result.hasMore) break;
      }
      if (!items.length || controller.signal.aborted) return items;
      try {
        const states = await api.prActivity(repo, number, "thread-states", 1, controller.signal);
        const byId = new Map(states.items.map((item) => [item.node_id, item]));
        if (!controller.signal.aborted) setThreadStateError("");
        return items.map((item) => ({ ...item, ...(item.node_id ? byId.get(item.node_id) : undefined) }));
      } catch (e) {
        if (!controller.signal.aborted) setThreadStateError(e instanceof Error ? e.message : "Couldn't load thread state.");
        return items;
      }
    };
    Promise.all([api.prActivity(repo, number, "timeline", page, controller.signal), page === 1 ? loadThreads() : Promise.resolve(null)])
      .then((results) => {
        if (controller.signal.aborted) return;
        setData((prev) => [[...new Map([
          ...(page === 1 ? [] : prev[0]), ...results[0].items,
        ].map((item) => [activityKey(item), item])).values()], results[1] ?? prev[1]]);
        setMore(results[0].hasMore);
        setTimelineWarning((prev) => results[0].warning ?? (page === 1 ? "" : prev));
      }).catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't load the conversation.");
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [repo, number, page, retry]);
  const entries = buildConversation(data[0], data[1], !more);
  const baseUrl = `https://github.com/${repo}/pull/${number}`;
  return <div className="prv-timeline" role="tabpanel" aria-label="Conversation">
    {entries.map((entry) => <article className={`prv-timeline-entry prv-timeline-${entry.kind}`} key={activityKey(entry.item)}>
      <span className="prv-timeline-avatar" aria-hidden="true">{entry.kind === "commits" ? <IconCommit width={16} height={16} /> : entry.kind === "review" || entry.item.event === "ready_for_review" || entry.item.event === "review_requested" ? <IconEye width={16} height={16} /> : entry.item.event === "cross-referenced" ? <IconExternal width={16} height={16} /> : entry.kind === "event" ? <IconBranch width={16} height={16} /> : entry.item.user?.avatar_url ? <img src={entry.item.user.avatar_url} alt="" /> : (entry.item.user?.login ?? "?").slice(0, 1).toUpperCase()}</span>
      {entry.kind === "commits" ? <PrCommitGroup items={entry.commits!} repo={repo} /> : entry.kind === "event" ? <PrTimelineEvent item={entry.item} baseUrl={baseUrl} /> : entry.kind === "comment" ? <PrComment item={entry.item} baseUrl={baseUrl} /> : <>
        <div className="prv-review-event">
          <strong>{entry.item.user?.login ?? "ghost"}</strong>
          <span>{entry.kind === "thread" ? "commented on code" : ({ APPROVED: "approved these changes", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "had their review dismissed", PENDING: "has a pending review" }[entry.item.state?.toUpperCase() ?? ""] ?? "reviewed")}</span>
          {(entry.item.submitted_at || entry.item.created_at) && <time>{new Date(entry.item.submitted_at || entry.item.created_at!).toLocaleString()}</time>}
        </div>
        {entry.kind === "review" && entry.item.body && <PrComment item={{ ...entry.item, created_at: entry.item.submitted_at }} baseUrl={baseUrl} />}
        {entry.threads.map((thread) => <details className="prv-code-thread" key={thread.comment.id} open={!thread.comment.is_collapsed}>
          <summary><strong>{thread.comment.path}</strong><span>{thread.comment.line ? `Line ${thread.comment.line}` : thread.comment.original_line ? `Original line ${thread.comment.original_line}` : "Code comment"}</span>{thread.comment.is_resolved && <span className="prv-label">Resolved</span>}{thread.comment.is_outdated && <span className="prv-label">Outdated</span>}</summary>
          {thread.comment.diff_hunk && <pre className="prv-patch">{thread.comment.diff_hunk.split("\n").map((line, i) => <div key={i} className={line.startsWith("+") ? "prv-added" : line.startsWith("-") ? "prv-removed" : ""}>{line || " "}</div>)}</pre>}
          <PrComment item={thread.comment} baseUrl={baseUrl} />
          {thread.replies.map((reply) => <PrComment key={reply.id} item={reply} baseUrl={baseUrl} />)}
          {canReply && (thread.comment.in_reply_to_id ?? thread.comment.id) !== undefined && <PrThreadReply
            commentId={(thread.comment.in_reply_to_id ?? thread.comment.id)!} draft={drafts[(thread.comment.in_reply_to_id ?? thread.comment.id)!] ?? ""}
            disabled={busy || loading} onDraft={onDraft} onReply={async (id, body) => {
              const posted = await onReply(id, body);
              setData((prev) => [prev[0], [...prev[1].filter((item) => item.id !== posted.id), posted]]);
            }} />}
        </details>)}
      </>}
    </article>)}
    {loading && <p className="prv-muted">Loading conversation…</p>}
    {timelineWarning && <p className="prv-muted">{timelineWarning}</p>}
    {threadStateError && <p className="prv-muted">Thread resolution status unavailable: {threadStateError} <button className="pr-link" disabled={busy || loading} onClick={() => { setPage(1); setRetry((v) => v + 1); }}>Retry thread status</button></p>}
    {error && <div className="acct-error" role="alert">{error} <button className="pr-link" disabled={busy || loading} onClick={() => setRetry((v) => v + 1)}>Retry conversation</button></div>}
    {!entries.length && !loading && !error && <p className="prv-muted">No conversation activity yet.</p>}
    {more && !error && !loading && <div className="prv-conversation-more"><button className="dialog-btn" disabled={busy} onClick={() => setPage((v) => v + 1)}>Load more activity</button></div>}
  </div>;
}

function PrActivityPanel({ repo, number, tab, total, sha, canComment, busy, onComment, drafts, onDraft }: {
  repo: string; number: number; tab: string; total?: number; sha: string; canComment: boolean; busy: boolean;
  onComment: (comment: PrLineComment) => Promise<void>;
  drafts: Record<string, string>; onDraft: (path: string, body: string) => void;
}) {
  const [items, setItems] = useState<PrActivity[]>([]);
  const [checks, setChecks] = useState<PrChecks>({ sha, checks: [], statuses: [], hasMore: false, errors: [] });
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const load = async () => {
      try {
        if (tab === "checks") {
          const data = await api.prChecks(repo, number, page, controller.signal);
          if (controller.signal.aborted) return;
          if (data.sha !== sha) throw new Error("The pull request changed. Refresh the pull request to load checks for its latest commit.");
          setChecks((prev) => ({ ...data, checks: page === 1 ? data.checks : [...prev.checks, ...data.checks], statuses: page === 1 ? data.statuses : [...prev.statuses, ...data.statuses] }));
          setMore(data.hasMore && data.errors.length === 0);
        } else {
          const data = await api.prActivity(repo, number, tab, page, controller.signal);
          if (controller.signal.aborted) return;
          if (tab === "files" && data.sha !== sha) throw new Error("The pull request changed. Refresh the pull request to load its latest files.");
          setItems((prev) => page === 1 ? data.items : [...prev, ...data.items]);
          setMore(data.hasMore);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't load activity.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, [repo, number, tab, page, retry, sha]);
  return <div className="prv-activity" role="tabpanel">
    {tab === "checks" ? <>
      {checks.errors.map((e, i) => <div key={i} className="acct-error" role="alert">Checks unavailable: {e}</div>)}
      {checks.errors.length > 0 && !loading && <button className="pr-link" onClick={() => { setPage(1); setRetry((v) => v + 1); }}>Retry checks</button>}
      {[...checks.checks, ...checks.statuses].map((c, i) => <div className="prv-check" key={`${c.id}:${i}`}>
        <strong>{c.name ?? c.context}</strong><span>{c.conclusion ?? c.status ?? c.state}</span>
        {(c.details_url || c.target_url) && <button className="pr-link" onClick={() => openExternal(c.details_url || c.target_url!)}>Details</button>}
      </div>)}
      {!loading && !error && !checks.errors.length && !checks.checks.length && !checks.statuses.length && <p>No checks or commit statuses reported.</p>}
    </> : items.map((item, i) => <article className="prv-entry" key={`${item.id ?? item.sha ?? item.filename}:${i}`}>
      {tab === "files" ? <details>
        <summary><strong>{item.filename}</strong> · {item.status} · +{item.additions} / −{item.deletions}</summary>
        {item.previous_filename && <p>Renamed from {item.previous_filename}</p>}
        {item.patch ? <PrFilePatch path={item.filename!} patch={item.patch} canComment={canComment} disabled={busy || loading || !!error} onComment={onComment} body={drafts[item.filename!] ?? ""} onBody={onDraft} />
          : <p>Diff unavailable (binary, large, or omitted by GitHub).</p>}
        <button className="pr-link" onClick={() => openExternal(`https://github.com/${repo}/pull/${number}/files`)}>View full diff on GitHub</button>
      </details> : <>
        <strong>{item.sha?.slice(0, 8)} · {item.commit?.author.name}</strong><pre className="prv-commit">{item.commit?.message}</pre>
      </>}
    </article>)}
    {tab !== "checks" && !items.length && !loading && !error && <p>No {tab} yet.</p>}
    {tab === "files" && items.length > 0 && <p className="prv-muted">GitHub may truncate large patches; use the full diff link when needed.</p>}
    {total !== undefined && !more && !loading && !error && items.length < total && <p className="prv-muted">
      GitHub returned {items.length} of {total} {tab}. <button className="pr-link" onClick={() => openExternal(`https://github.com/${repo}/pull/${number}/${tab}`)}>View all {tab} on GitHub</button>
    </p>}
    {loading && <p>Loading…</p>}
    {error && <div className="acct-error" role="alert">{error} <button className="pr-link" onClick={() => setRetry((v) => v + 1)}>Retry</button></div>}
    {more && !loading && !error && <button className="dialog-btn" onClick={() => setPage((v) => v + 1)}>Load more</button>}
  </div>;
}
