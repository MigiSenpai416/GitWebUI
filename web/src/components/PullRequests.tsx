import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useStore } from "../state/store";
import type { PrContext, PullRequestSummary } from "../types";
import { IconChevron, IconChevronDown, IconPlus, IconPullRequest, IconRefresh, IconSearch } from "./icons";
import { Section } from "./Sidebar";
import { PullRequestViewer } from "./PullRequestViewer";
import "./PullRequests.css";

export function PullRequests() {
  const login = useStore((s) => s.githubStatus?.user?.login);
  const connect = useStore((s) => s.openGitHubDialog);
  const create = useStore((s) => s.openPullRequest);
  const creating = useStore((s) => s.prDialogOpen);
  const remotes = useStore((s) => s.remotes);
  const remoteKey = remotes.map((r) => `${r.name}:${r.url}`).join("|");
  const [open, setOpen] = useState(true);
  const [ctx, setCtx] = useState<PrContext | null>(null);
  const [repo, setRepo] = useState("");
  const [state, setState] = useState("open");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PullRequestSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [error, setError] = useState("");
  const [contextError, setContextError] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const [contextRevision, setContextRevision] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [groups, setGroups] = useState<Record<string, boolean>>({});
  const wasCreating = useRef(creating);
  const refresh = () => {
    setPage(1);
    setRevision((v) => v + 1);
    if (!ctx?.baseCandidates.length) setContextRevision((v) => v + 1);
  };

  useEffect(() => {
    if (wasCreating.current && !creating) refresh();
    wasCreating.current = creating;
  }, [creating]);

  useEffect(() => {
    const controller = new AbortController();
    setCtx(null);
    setRepo("");
    setItems([]);
    setPage(1);
    setHasMore(false);
    setSelected(null);
    setGroups({});
    setContextError("");
    if (!login) return;
    setContextLoading(true);
    api.prContext(controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setCtx(data);
      setRepo(data.defaults.baseRepo ?? data.baseCandidates[0]?.fullName ?? "");
    }).catch((e) => {
      if (!controller.signal.aborted) setContextError(e.message);
    }).finally(() => {
      if (!controller.signal.aborted) setContextLoading(false);
    });
    return () => controller.abort();
  }, [login, remoteKey, contextRevision]);

  useEffect(() => {
    if (!repo || !login) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    if (page === 1) setItems([]);
    api.prList(repo, state === "merged" ? "closed" : state, page, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setItems((prev) => {
        const combined = page === 1 ? data.items : [...prev, ...data.items];
        return [...new Map(combined.map((p) => [p.number, p])).values()];
      });
      setHasMore(data.hasMore);
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [repo, state, page, login, revision]);

  const visible = items.filter((p) => (state !== "merged" || p.state === "merged")
    && (state !== "closed" || p.state === "closed")
    && `${p.title} #${p.number} ${p.author} ${p.head}`.toLowerCase().includes(query.toLowerCase()));
  const me = login?.toLowerCase();
  const sections = [
    { id: "mine", title: "My Pull Requests", items: visible.filter((p) => p.author.toLowerCase() === me) },
    { id: "assigned", title: "Assigned to Me", items: visible.filter((p) => p.assignees.some((u) => u.toLowerCase() === me)) },
    { id: "review", title: "Review Requested", items: visible.filter((p) => p.reviewers.some((u) => u.toLowerCase() === me)) },
    { id: "all", title: "All Pull Requests", items: visible },
  ];

  return (
    <>
      <Section icon={<IconPullRequest width={15} height={15} />} label="Pull Requests" count={visible.length}
        open={open} onToggle={() => setOpen((v) => !v)} actions={[
          { title: "Refresh pull requests", icon: <IconRefresh width={14} height={14} />, onClick: refresh },
          { title: "Create pull request", icon: <IconPlus width={15} height={15} />, onClick: () => create(), tone: "green" },
        ]}>
        {!login ? <div className="sb-empty"><button className="pr-link" onClick={connect}>Connect GitHub</button> to view pull requests.</div>
          : contextLoading ? <div className="sb-empty">Loading repositories…</div>
          : contextError ? <div className="sb-empty" role="alert">{contextError}</div>
          : !ctx?.baseCandidates.length ? <div className="sb-empty">No accessible GitHub remotes. Check your remote URL and account access.</div>
          : <>
            <div className="prs-filters">
              <div className="prs-scope">
              <select className="prs-repository" title={repo} aria-label="Pull request repository" value={repo} onChange={(e) => { setRepo(e.target.value); setPage(1); setSelected(null); setItems([]); setGroups({}); }}>
                {ctx.baseCandidates.map((r) => <option key={r.fullName}>{r.fullName}</option>)}
              </select>
              <select className={`prs-state prs-${state}`} aria-label="Pull request state" value={state} onChange={(e) => { setState(e.target.value); setPage(1); setItems([]); }}>
                <option value="open">Open</option><option value="closed">Closed</option><option value="merged">Merged</option><option value="all">All states</option>
              </select>
              </div>
              <label className="prs-search"><IconSearch width={13} height={13} /><input aria-label="Search pull requests" placeholder="Search pull requests…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            </div>
            {sections.map((group) => <div key={group.id}>
              <button className="sb-item prs-group" title={group.id === "review" ? "Reviews requested directly from you; team requests are shown in PR details" : undefined}
                aria-expanded={!!groups[group.id]} onClick={() => setGroups((v) => ({ ...v, [group.id]: !v[group.id] }))}>
                {groups[group.id] ? <IconChevronDown width={12} height={12} /> : <IconChevron width={12} height={12} />}
                <span>{group.title}</span><span className="sb-head-count">{group.items.length}</span>
              </button>
              {groups[group.id] && group.items.map((p) => <button key={p.number} className="sb-item prs-item" title={`#${p.number} ${p.title}\n${p.author} · ${p.draft ? "Draft" : p.state}`}
                onClick={() => setSelected(p.number)}>
                <IconPullRequest width={13} height={13} className={`prs-${p.draft ? "draft" : p.state}`} />
                <span className="sb-item-name">#{p.number} {p.title}</span>
              </button>)}
              {groups[group.id] && !group.items.length && !loading && <div className="sb-empty">No matching pull requests</div>}
            </div>)}
            {loading && <div className="sb-empty">Loading pull requests…</div>}
            {error && <div className="sb-empty" role="alert">{error}<button className="pr-link" onClick={refresh}>Retry</button></div>}
            {hasMore && !loading && !error && <button className="pr-link prs-more" onClick={() => setPage((v) => v + 1)}>Load more pull requests</button>}
            {hasMore && <div className="sb-empty">Search and counts cover loaded PRs.</div>}
          </>}
      </Section>
      {selected !== null && repo && login && <PullRequestViewer key={`${repo}:${selected}:${login}`} repo={repo} number={selected}
        onClose={() => setSelected(null)} onChanged={refresh} />}
    </>
  );
}
