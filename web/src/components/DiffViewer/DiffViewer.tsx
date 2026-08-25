import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useStore } from "../../state/store";
import { api } from "../../api/client";
import type { DiffResult } from "../../types";
import {
  baseExtensions,
  computeHunks,
  diffViewExtensions,
  fileViewExtensions,
  loadLanguage,
  setSearchHighlights,
} from "./codeMirrorDiff";
import { DiffMinimap } from "./DiffMinimap";
import "./DiffViewer.css";

export function DiffViewer() {
  const selected = useStore((s) => s.selectedFile);
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const closeFile = useStore((s) => s.closeFile);
  const stage = useStore((s) => s.stage);
  const unstage = useStore((s) => s.unstage);
  const setError = useStore((s) => s.setError);

  const refreshTick = useStore((s) => s.refreshTick);

  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const hunkIndex = useRef<number>(-1);
  const prevSelKey = useRef<string>("");
  const buildSig = useRef<string>("");
  const [buildTick, setBuildTick] = useState(0);
  const getView = useCallback(() => viewRef.current, []);
  const selectionKey = selected
    ? `${selected.source}:${selected.path}:${selected.hash ?? ""}`
    : "";

  // Only working-tree diffs change over time; commit diffs are immutable, so
  // they never refetch (and keep their scroll position) on refresh.
  const refreshKey = selected && selected.source !== "commit" ? refreshTick : 0;

  // Fetch the diff on selection change (with a loading state) or, quietly, on
  // a working-tree refresh.
  useEffect(() => {
    if (!selected) return;
    const selKey = `${selected.source}:${selected.path}:${selected.hash ?? ""}`;
    const selectionChanged = prevSelKey.current !== selKey;
    prevSelKey.current = selKey;

    let cancelled = false;
    if (selectionChanged) {
      setLoading(true);
      setDiff(null);
    }
    api
      .diff(selected.source, selected.path, selected.hash)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, refreshKey, setError]);

  const hunks = useMemo(() => (diff ? computeHunks(diff.rows) : []), [diff]);

  const searchMatchRanges = useMemo(() => {
    if (!searchOpen || !searchQuery || buildTick === 0 || !diff || diff.binary) return [];
    const text = viewRef.current?.state.doc.toString();
    return text == null ? [] : findTextMatchRanges(text, searchQuery);
  }, [searchOpen, searchQuery, buildTick, diff, viewMode]);
  const searchMatchCount = searchMatchRanges.length / 2;

  const normalizedSearchIndex =
    searchMatchCount === 0
      ? -1
      : ((activeSearchIndex % searchMatchCount) + searchMatchCount) % searchMatchCount;

  // A search belongs to the open file. Do not carry its query or highlights to
  // a different selection.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setActiveSearchIndex(0);
  }, [selectionKey]);

  // Build / rebuild the editor when diff, mode, or language changes.
  useEffect(() => {
    if (!hostRef.current || !diff || diff.binary) return;
    let disposed = false;

    const build = async () => {
      const langExt = await loadLanguage(diff.language);
      if (disposed || !hostRef.current) return;

      const doc =
        viewMode === "file"
          ? (diff.fileContent ?? rowsToNewText(diff))
          : diff.rows.map((r) => r.text).join("\n");

      // A refresh/refocus refetches the same content: if nothing actually
      // changed, leave the editor untouched so the reader's scroll position and
      // selection are preserved (no jump to the top).
      if (viewRef.current && viewRef.current.state.doc.toString() === doc) {
        buildSig.current = `${selected?.source}:${selected?.path}:${selected?.hash ?? ""}:${viewMode}`;
        return;
      }

      const extensions = [
        ...baseExtensions(),
        ...(langExt ? [langExt] : []),
        ...(viewMode === "file" ? fileViewExtensions() : diffViewExtensions(diff.rows)),
      ];

      const state = EditorState.create({ doc, extensions });

      const prevScroll = viewRef.current?.scrollDOM.scrollTop ?? 0;
      const hadView = !!viewRef.current;
      if (viewRef.current) {
        viewRef.current.setState(state);
      } else {
        viewRef.current = new EditorView({ state, parent: hostRef.current });
      }
      hunkIndex.current = -1;
      setBuildTick((t) => t + 1);

      // Focus the first change when the file/view first opens (but not on a
      // silent working-tree refresh, which keeps the same selection + mode).
      const sig = `${selected?.source}:${selected?.path}:${selected?.hash ?? ""}:${viewMode}`;
      const isNewView = buildSig.current !== sig;
      buildSig.current = sig;
      if (!isNewView && hadView) {
        // Content changed but it's the same file/view: keep the scroll offset
        // across the rebuild instead of snapping back to the top.
        requestAnimationFrame(() => {
          if (viewRef.current) viewRef.current.scrollDOM.scrollTop = prevScroll;
        });
      } else if (viewMode === "diff" && isNewView) {
        const starts = computeHunks(diff.rows);
        if (starts.length) {
          const view = viewRef.current;
          const lineNo = Math.min(starts[0], view.state.doc.lines);
          const pos = view.state.doc.line(lineNo).from;
          requestAnimationFrame(() => {
            viewRef.current?.dispatch({
              selection: { anchor: pos },
              effects: EditorView.scrollIntoView(pos, { y: "center" }),
            });
          });
          hunkIndex.current = 0;
        }
      }
    };

    build();
    return () => {
      disposed = true;
    };
  }, [diff, viewMode]);

  // Tear down the editor on unmount.
  useEffect(() => {
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

  // Keep the match set current and center the active hit. The CodeMirror
  // plugin decorates the visible subset, and rebuilding the editor reapplies
  // search to the new document through buildTick.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const effects = [setSearchHighlights.of({ ranges: searchMatchRanges, activeIndex: normalizedSearchIndex })];

    if (normalizedSearchIndex < 0) {
      view.dispatch({ effects });
      return;
    }

    const activeFrom = searchMatchRanges[normalizedSearchIndex * 2];
    view.dispatch({
      selection: { anchor: activeFrom },
      effects: [
        ...effects,
        EditorView.scrollIntoView(activeFrom, { y: "center" }),
      ],
    });
  }, [searchMatchRanges, normalizedSearchIndex, buildTick]);

  const gotoHunk = (dir: 1 | -1) => {
    const view = viewRef.current;
    if (!view || hunks.length === 0 || viewMode !== "diff") return;
    let idx = hunkIndex.current + dir;
    if (idx < 0) idx = hunks.length - 1;
    if (idx >= hunks.length) idx = 0;
    hunkIndex.current = idx;
    const lineNo = hunks[idx];
    if (lineNo <= view.state.doc.lines) {
      const pos = view.state.doc.line(lineNo).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    }
  };

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    requestAnimationFrame(() => viewRef.current?.focus());
  }, []);

  const gotoSearchMatch = (dir: 1 | -1) => {
    if (searchMatchCount === 0) return;
    setActiveSearchIndex((index) => {
      const current = ((index % searchMatchCount) + searchMatchCount) % searchMatchCount;
      return (current + dir + searchMatchCount) % searchMatchCount;
    });
  };

  // Keyboard: Ctrl/Cmd+F searches this file, Escape closes search before the
  // file, and Alt+Down/Up navigates diff hunks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Higher-level dialogs own keyboard input while they cover the viewer.
      // Include legacy backdrops that do not expose aria-modal yet.
      if (document.querySelector('.dialog-backdrop, [aria-modal="true"], [role="alertdialog"]')) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
      } else if (e.key === "Escape" && searchOpen) {
        e.preventDefault();
        closeSearch();
      } else if (e.key === "Escape") closeFile();
      else if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        gotoHunk(1);
      } else if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        gotoHunk(-1);
      }
    };
    // Capture before a modal's document listener can close and unmount it;
    // otherwise the same Escape could then fall through to this viewer.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunks, viewMode, searchOpen, openSearch, closeSearch]);

  if (!selected) return null;

  const isWorking = selected.source !== "commit";
  const sourceLabel =
    selected.source === "staged" ? "Staged" : selected.source === "unstaged" ? "Unstaged" : "Commit";

  const onStageToggle = () => {
    if (selected.source === "unstaged") stage([selected.path]);
    else if (selected.source === "staged") unstage([selected.path]);
  };

  const showMinimap = viewMode === "diff" && !!diff && !diff.binary && !diff.empty;

  return (
    <div className="diff-viewer">
      <div className="dv-header">
        <div className="dv-path" title={selected.path}>
          {renderPath(selected.path)}
        </div>
        <div className="spacer" />
        {isWorking && (
          <span className={"dv-source-badge src-" + selected.source}>{sourceLabel}</span>
        )}
        <div className="dv-toggle">
          <button
            className={viewMode === "file" ? "active" : ""}
            onClick={() => setViewMode("file")}
          >
            File View
          </button>
          <button
            className={viewMode === "diff" ? "active" : ""}
            onClick={() => setViewMode("diff")}
          >
            Diff View
          </button>
        </div>
        <div className="dv-nav">
          <button title="Previous change (Alt+Up)" onClick={() => gotoHunk(-1)} disabled={viewMode !== "diff" || hunks.length === 0}>
            ▲
          </button>
          <button title="Next change (Alt+Down)" onClick={() => gotoHunk(1)} disabled={viewMode !== "diff" || hunks.length === 0}>
            ▼
          </button>
        </div>
        {isWorking && (
          <button className="dv-stage btn-accent" onClick={onStageToggle}>
            {selected.source === "staged" ? "Unstage File" : "Stage File"}
          </button>
        )}
        <button className="dv-close" title="Close (Esc)" onClick={closeFile}>
          ✕
        </button>
      </div>

      {searchOpen && (
        <div className="dv-find-row">
          <div className="dv-find">
            <input
              ref={searchInputRef}
              aria-label="Find in file"
              placeholder="Find in file"
              value={searchQuery}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setSearchQuery(e.currentTarget.value);
                setActiveSearchIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  gotoSearchMatch(e.shiftKey ? -1 : 1);
                }
              }}
            />
            <span className="dv-find-count" aria-live="polite">
              {!searchQuery
                ? ""
                : searchMatchCount === 0
                  ? "No results"
                  : `${normalizedSearchIndex + 1} of ${searchMatchCount}`}
            </span>
            <button
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
              disabled={searchMatchCount === 0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => gotoSearchMatch(-1)}
            >
              ▲
            </button>
            <button
              title="Next match (Enter)"
              aria-label="Next match"
              disabled={searchMatchCount === 0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => gotoSearchMatch(1)}
            >
              ▼
            </button>
            <button title="Close search (Esc)" aria-label="Close search" onClick={closeSearch}>
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="dv-body">
        {loading && <div className="dv-message">Loading diff…</div>}
        {!loading && diff?.binary && (
          <div className="dv-message">Binary file — no text diff available.</div>
        )}
        {!loading && diff && !diff.binary && diff.empty && viewMode === "diff" && (
          <div className="dv-message">No changes to display.</div>
        )}
        <div
          className={"dv-editor" + (showMinimap ? " has-minimap" : "")}
          ref={hostRef}
          style={{ display: diff && !diff.binary ? "block" : "none" }}
        />
        {showMinimap && diff && (
          <DiffMinimap rows={diff.rows} getView={getView} buildTick={buildTick} />
        )}
      </div>
    </div>
  );
}

function rowsToNewText(diff: DiffResult): string {
  return diff.rows.filter((r) => r.type !== "del").map((r) => r.text).join("\n");
}

function renderPath(path: string): React.ReactNode {
  const parts = path.split("/");
  const name = parts.pop();
  return (
    <>
      {parts.length > 0 && <span className="dv-path-dir">{parts.join("/")}/</span>}
      <span className="dv-path-name">{name}</span>
    </>
  );
}

/** Flat literal, case-insensitive match ranges using original-text offsets. */
export function findTextMatchRanges(text: string, query: string): number[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escaped, "giu");
  const ranges: number[] = [];
  for (const match of text.matchAll(matcher)) {
    ranges.push(match.index, match.index + match[0].length);
  }
  return ranges;
}
