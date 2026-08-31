import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../api/client";
import type { DiffResult, FileHistoryEntry } from "../types";
import { BlameView } from "./BlameView";
import { FileManagerPreview } from "./FileManagerPreview";
import { baseExtensions, computeHunks, diffViewExtensions, loadLanguage } from "./DiffViewer/codeMirrorDiff";
import { IconBlame, IconClose, IconFile, IconHistory, IconSearch, IconSpinner } from "./icons";
import "./FileHistoryView.css";

interface Props {
  path: string;
  onClose: () => void;
  onError: (message: string) => void;
}

interface RevisionTarget {
  path: string;
  hash: string;
  label: string;
}

const PAGE_SIZE = 100;

export function FileHistoryView({ path, onClose, onError }: Props) {
  const [entries, setEntries] = useState<FileHistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [preview, setPreview] = useState<RevisionTarget | null>(null);
  const [blame, setBlame] = useState<RevisionTarget | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadGeneration = useRef(0);
  const restoreFocusSelector = useRef("");

  const load = useCallback(async (reset: boolean, search: string) => {
    const generation = ++loadGeneration.current;
    if (reset) setLoading(true);
    else setLoadingMore(true);
    try {
      const result = await api.fileHistory(path, reset ? 0 : entries.length, PAGE_SIZE, search);
      if (generation !== loadGeneration.current) return;
      setEntries((before) => reset ? result.entries : [...before, ...result.entries]);
      setHasMore(result.hasMore);
      if (reset) {
        setActiveQuery(search);
        setSelectedHash(result.entries[0]?.hash ?? null);
        listRef.current?.scrollTo({ top: 0 });
      }
    } catch (cause) {
      if (generation === loadGeneration.current) onError(messageOf(cause));
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [entries.length, onError, path]);

  useEffect(() => {
    setEntries([]);
    setHasMore(false);
    setQuery("");
    setActiveQuery("");
    setSelectedHash(null);
    void load(true, "");
    return () => { loadGeneration.current += 1; };
    // A new path owns a new history session; pagination changes must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const virtualizer = useVirtualizer({
    count: entries.length + Number(hasMore),
    getScrollElement: () => listRef.current,
    estimateSize: (index) => index < entries.length ? 82 : 52,
    overscan: 12,
  });
  const selected = entries.find((entry) => entry.hash === selectedHash) ?? entries[0] ?? null;

  const search = (event: React.FormEvent) => {
    event.preventDefault();
    if (!query) return;
    void load(true, query);
  };

  const clearSearch = () => {
    setQuery("");
    void load(true, "");
  };

  const openPreview = (entry: FileHistoryEntry) => {
    if (!entry.contentHash) return;
    restoreFocusSelector.current = ".fh-preview-action";
    setPreview({
      path: entry.contentPath,
      hash: entry.contentHash,
      label: entry.status === "D" ? "Before deletion" : "Commit",
    });
  };

  const openBlame = (entry: FileHistoryEntry) => {
    if (!entry.contentHash) return;
    restoreFocusSelector.current = ".fh-blame-action";
    setBlame({ path: entry.contentPath, hash: entry.contentHash, label: "Commit" });
  };

  const closeSubview = useCallback(() => {
    setPreview(null);
    setBlame(null);
    const selector = restoreFocusSelector.current;
    window.setTimeout(() => document.querySelector<HTMLButtonElement>(selector)?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!preview && !blame) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeSubview();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [blame, closeSubview, preview]);

  if (preview) {
    return (
      <FileManagerPreview
        path={preview.path}
        head={preview.hash}
        revisionLabel={preview.label}
        shortcutsBlocked={false}
        onClose={closeSubview}
        onError={onError}
      />
    );
  }
  if (blame) {
    return <BlameView path={blame.path} revision={blame.hash} onClose={closeSubview} onError={onError} />;
  }

  return (
    <main className="fh-view" role="region" aria-label={`File history for ${path}`}>
      <header className="fh-header">
        <button className="fh-back" onClick={onClose} aria-label="Back to file list" title="Back to file list">←</button>
        <span className="fh-header-icon"><IconHistory /></span>
        <div className="fh-heading">
          <strong>{fileName(path)}</strong>
          <span title={path}>{path}</span>
        </div>
        <span className="fh-order">Newest changes first</span>
        <button className="fh-close" onClick={onClose} aria-label="Close file history" title="Close file history"><IconClose /></button>
      </header>

      <div className="fh-body">
        <aside className="fh-timeline" aria-label="Commits that changed this file">
          <form className="fh-search" onSubmit={search}>
            <label htmlFor="file-history-search">Remember code that disappeared?</label>
            <div>
              <IconSearch />
              <input
                id="file-history-search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Exact text from the file"
                spellCheck={false}
              />
              <button type="submit" disabled={!query || loading}>
                {loading && query ? <IconSpinner /> : "Find"}
              </button>
            </div>
            <small>Finds commits where this exact, case-sensitive text was added or removed.</small>
          </form>
          {activeQuery && (
            <div className="fh-search-active">
              <span>Changes involving <code>{activeQuery}</code></span>
              <button onClick={clearSearch}>Show all history</button>
            </div>
          )}
          <div className="fh-list" ref={listRef}>
            {loading && entries.length === 0 ? (
              <div className="fh-message"><IconSpinner /> Reading file history…</div>
            ) : entries.length === 0 ? (
              <div className="fh-message">
                {activeQuery ? "That text was not added or removed in this file's reachable history." : "No commits were found for this path."}
              </div>
            ) : (
              <div className="fh-list-inner" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((row) => {
                  if (row.index === entries.length) {
                    return (
                      <div className="fh-load-row" key="load-more" style={{ transform: `translateY(${row.start}px)` }}>
                        <button disabled={loadingMore} onClick={() => void load(false, activeQuery)}>
                          {loadingMore ? <><IconSpinner /> Loading…</> : "Load older changes"}
                        </button>
                      </div>
                    );
                  }
                  const entry = entries[row.index];
                  return (
                    <button
                      className={`fh-entry${selected?.hash === entry.hash ? " selected" : ""}`}
                      key={entry.hash}
                      style={{ transform: `translateY(${row.start}px)` }}
                      onClick={() => setSelectedHash(entry.hash)}
                    >
                      <span className={`status-badge st-${entry.status}`}>{entry.status}</span>
                      <span className="fh-entry-main">
                        <strong>{entry.subject || "Untitled commit"}</strong>
                        <span>{entry.author} · {formatDate(entry.dateISO)}</span>
                        {entry.oldPath && <small title={`${entry.oldPath} → ${entry.path}`}>{entry.oldPath} → {entry.path}</small>}
                      </span>
                      <code>{entry.shortHash}</code>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <section className="fh-inspector" aria-label="Selected file change">
          {selected ? (
            <HistoryDiff
              key={selected.hash}
              entry={selected}
              onPreview={openPreview}
              onBlame={openBlame}
              onError={onError}
            />
          ) : (
            <div className="fh-empty-detail">Select a history entry to inspect what changed.</div>
          )}
        </section>
      </div>
    </main>
  );
}

interface HistoryDiffProps {
  entry: FileHistoryEntry;
  onPreview: (entry: FileHistoryEntry) => void;
  onBlame: (entry: FileHistoryEntry) => void;
  onError: (message: string) => void;
}

function HistoryDiff({ entry, onPreview, onBlame, onError }: HistoryDiffProps) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorReady, setEditorReady] = useState(false);
  const [activeHunk, setActiveHunk] = useState(-1);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const hunks = useMemo(() => diff ? computeHunks(diff.rows) : [], [diff]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDiff(null);
    setEditorReady(false);
    setActiveHunk(-1);
    api.diff("commit", entry.path, entry.hash)
      .then((result) => !cancelled && setDiff(result))
      .catch((cause) => !cancelled && onError(messageOf(cause)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [entry.hash, entry.path, onError]);

  useEffect(() => {
    if (!diff || diff.binary || !hostRef.current) return;
    let disposed = false;
    let scrollFrame = 0;
    const build = async () => {
      const language = await loadLanguage(entry.path, diff.language);
      if (disposed || !hostRef.current) return;
      const state = EditorState.create({
        doc: diff.rows.map((row) => row.text).join("\n"),
        extensions: [
          ...baseExtensions(),
          ...(language ? [language] : []),
          ...diffViewExtensions(diff.rows),
        ],
      });
      if (viewRef.current) viewRef.current.setState(state);
      else viewRef.current = new EditorView({ state, parent: hostRef.current });
      setEditorReady(true);
      if (hunks.length > 0) {
        const view = viewRef.current;
        const line = Math.min(hunks[0], view.state.doc.lines);
        const position = view.state.doc.line(line).from;
        setActiveHunk(0);
        scrollFrame = requestAnimationFrame(() => {
          if (disposed || viewRef.current !== view) return;
          view.dispatch({
            selection: { anchor: position },
            effects: EditorView.scrollIntoView(position, { y: "center" }),
          });
        });
      }
    };
    void build();
    return () => {
      disposed = true;
      cancelAnimationFrame(scrollFrame);
    };
  }, [diff, entry.path, hunks]);

  useEffect(() => () => {
    viewRef.current?.destroy();
    viewRef.current = null;
  }, []);

  const counts = useMemo(() => ({
    added: diff?.rows.filter((row) => row.type === "add").length ?? 0,
    deleted: diff?.rows.filter((row) => row.type === "del").length ?? 0,
  }), [diff]);

  const gotoHunk = useCallback((direction: 1 | -1) => {
    const view = viewRef.current;
    if (!view || !editorReady || hunks.length === 0) return;
    const current = activeHunk < 0 ? 0 : activeHunk;
    const next = (current + direction + hunks.length) % hunks.length;
    const line = Math.min(hunks[next], view.state.doc.lines);
    const position = view.state.doc.line(line).from;
    setActiveHunk(next);
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
  }, [activeHunk, editorReady, hunks]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.defaultPrevented) return;
      if (event.key === "ArrowUp") gotoHunk(-1);
      else if (event.key === "ArrowDown") gotoHunk(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [gotoHunk]);

  return (
    <div className="fh-diff">
      <header className="fh-commit-header">
        <div className="fh-commit-title">
          <span><span className={`status-badge st-${entry.status}`}>{entry.status}</span> Commit {entry.shortHash}</span>
          <strong>{entry.subject || "Untitled commit"}</strong>
          <small>{entry.author}{entry.email && ` <${entry.email}>`} · {formatFullDate(entry.dateISO)}</small>
          <code title={entry.path}>{entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}</code>
        </div>
        <div className="fh-actions">
          <button className="fh-preview-action" onClick={() => onPreview(entry)} disabled={!entry.contentHash}>
            <IconFile /> {entry.status === "D" ? "View before deletion" : "View complete file"}
          </button>
          <button className="fh-blame-action" onClick={() => onBlame(entry)} disabled={!entry.contentHash}>
            <IconBlame /> Blame this revision
          </button>
        </div>
      </header>
      <div className="fh-diff-summary">
        <span className="added">+{counts.added} added</span>
        <span className="deleted">−{counts.deleted} deleted</span>
        <div className="fh-hunk-nav" aria-label="Change navigation">
          <span>{hunks.length > 0 ? `Change ${Math.max(activeHunk + 1, 1)} of ${hunks.length}` : "No change blocks"}</span>
          <button aria-label="Previous change" title="Previous change (Alt+Up)" onClick={() => gotoHunk(-1)} disabled={!editorReady || hunks.length === 0}>▲</button>
          <button aria-label="Next change" title="Next change (Alt+Down)" onClick={() => gotoHunk(1)} disabled={!editorReady || hunks.length === 0}>▼</button>
        </div>
        <span className="fh-diff-context">Compared with this commit's first parent.</span>
      </div>
      <div className="fh-diff-body">
        {(loading || (!!diff && !diff.binary && !diff.empty && !editorReady)) && <div className="fh-message"><IconSpinner /> Loading this file change…</div>}
        {!loading && diff?.binary && <div className="fh-message">Binary file — Git recorded the change, but there is no text diff to display.</div>}
        {!loading && diff && !diff.binary && diff.empty && (
          <div className="fh-message">
            {entry.status === "R" ? "The file was renamed without content changes." : "This change has no text lines to display (the file may be empty)."}
          </div>
        )}
        <div className="fh-diff-editor" ref={hostRef} style={{ display: diff && !diff.binary && !diff.empty && editorReady ? "block" : "none" }} />
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatFullDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
