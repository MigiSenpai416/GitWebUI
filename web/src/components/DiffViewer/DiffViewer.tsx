import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useStore } from "../../state/store";
import { api } from "../../api/client";
import type { DiffResult, DiffRow } from "../../types";
import {
  baseExtensions,
  computeHunks,
  diffViewExtensions,
  fileViewExtensions,
  findTextMatchRanges,
  loadLanguage,
  sameDiffRows,
  setSearchHighlights,
  splitDiffRows,
  splitDiffViewExtensions,
} from "./codeMirrorDiff";
import { DiffMinimap, type DiffOverviewLine } from "./DiffMinimap";
import { IconDiffSplit, IconDiffUnified } from "../icons";
import "./DiffViewer.css";

export function DiffViewer() {
  const selected = useStore((s) => s.selectedFile);
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const diffLayout = useStore((s) => s.diffLayout);
  const setDiffLayout = useStore((s) => s.setDiffLayout);
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
  const oldHostRef = useRef<HTMLDivElement>(null);
  const newHostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const oldViewRef = useRef<EditorView | null>(null);
  const newViewRef = useRef<EditorView | null>(null);
  const searchReturnViewRef = useRef<EditorView | null>(null);
  const hunkIndex = useRef<number>(-1);
  const prevSelKey = useRef<string>("");
  const loadedSelectionKeyRef = useRef<string>("");
  const buildSig = useRef<string>("");
  const builtRowsRef = useRef<readonly DiffRow[] | null>(null);
  const [buildTick, setBuildTick] = useState(0);
  const getView = useCallback(
    () => viewMode === "file" || diffLayout === "unified"
      ? viewRef.current
      : (newViewRef.current ?? oldViewRef.current),
    [diffLayout, viewMode],
  );
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
      loadedSelectionKeyRef.current = "";
      buildSig.current = "";
      setLoading(true);
      setDiff(null);
    }
    api
      .diff(selected.source, selected.path, selected.hash)
      .then((d) => {
        if (!cancelled) {
          loadedSelectionKeyRef.current = selKey;
          setDiff(d);
        }
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

  const split = useMemo(() => (diff ? splitDiffRows(diff.rows) : null), [diff]);
  const hunks = useMemo(
    () => diffLayout === "split" ? (split?.hunkStarts ?? []) : (diff ? computeHunks(diff.rows) : []),
    [diff, diffLayout, split],
  );
  const overviewLines = useMemo<DiffOverviewLine[]>(() => {
    if (!diff) return [];
    if (diffLayout !== "split" || !split) {
      return diff.rows.map((row) => row.type === "context" ? null : row.type);
    }
    return split.oldRows.map((oldRow, index) => {
      const deleted = oldRow.type === "del";
      const added = split.newRows[index].type === "add";
      if (deleted && added) return "both";
      if (deleted) return "del";
      if (added) return "add";
      return null;
    });
  }, [diff, diffLayout, split]);

  const searchMatchRanges = useMemo(() => {
    if (!searchOpen || !searchQuery || buildTick === 0 || !diff || diff.binary) {
      return { unified: [] as number[], old: [] as number[], new: [] as number[] };
    }
    if (viewMode === "diff" && diffLayout === "split") {
      const oldText = oldViewRef.current?.state.doc.toString();
      const newText = newViewRef.current?.state.doc.toString();
      return {
        unified: [],
        old: oldText == null ? [] : findTextMatchRanges(oldText, searchQuery),
        new: newText == null ? [] : findTextMatchRanges(newText, searchQuery),
      };
    }
    const text = viewRef.current?.state.doc.toString();
    return {
      unified: text == null ? [] : findTextMatchRanges(text, searchQuery),
      old: [],
      new: [],
    };
  }, [searchOpen, searchQuery, buildTick, diff, viewMode, diffLayout]);
  const oldSearchMatchCount = searchMatchRanges.old.length / 2;
  const searchMatchCount =
    (searchMatchRanges.unified.length + searchMatchRanges.old.length + searchMatchRanges.new.length) / 2;

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
    searchReturnViewRef.current = null;
  }, [selectionKey]);

  // A layout switch destroys the previous editor. Do not retain it as the
  // focus target while an open search moves to the newly built view.
  useEffect(() => {
    searchReturnViewRef.current = null;
  }, [diffLayout, viewMode]);

  // Build / rebuild the active editor layout when diff, mode, or language changes.
  useEffect(() => {
    if (
      !hostRef.current ||
      !oldHostRef.current ||
      !newHostRef.current ||
      !diff ||
      diff.binary ||
      loadedSelectionKeyRef.current !== selectionKey
    ) return;
    let disposed = false;

    const build = async () => {
      const langExt = await loadLanguage(diff.path, diff.language);
      if (disposed || !hostRef.current || !oldHostRef.current || !newHostRef.current) return;

      const sig = `${selectionKey}:${viewMode}:${diffLayout}`;

      if (viewMode === "diff" && diffLayout === "split" && split) {
        viewRef.current?.destroy();
        viewRef.current = null;

        const oldDoc = split.oldRows.map((row) => row.text).join("\n");
        const newDoc = split.newRows.map((row) => row.text).join("\n");
        if (
          buildSig.current === sig &&
          sameDiffRows(builtRowsRef.current, diff.rows) &&
          oldViewRef.current?.state.doc.toString() === oldDoc &&
          newViewRef.current?.state.doc.toString() === newDoc
        ) {
          buildSig.current = sig;
          return;
        }

        const oldState = EditorState.create({
          doc: oldDoc,
          extensions: [
            ...baseExtensions(false),
            ...(langExt ? [langExt] : []),
            ...splitDiffViewExtensions(split.oldRows, "old"),
          ],
        });
        const newState = EditorState.create({
          doc: newDoc,
          extensions: [
            ...baseExtensions(false),
            ...(langExt ? [langExt] : []),
            ...splitDiffViewExtensions(split.newRows, "new"),
          ],
        });

        const prevScroll = newViewRef.current?.scrollDOM.scrollTop ?? 0;
        const hadViews = !!oldViewRef.current && !!newViewRef.current;
        if (oldViewRef.current) oldViewRef.current.setState(oldState);
        else oldViewRef.current = new EditorView({ state: oldState, parent: oldHostRef.current });
        if (newViewRef.current) newViewRef.current.setState(newState);
        else newViewRef.current = new EditorView({ state: newState, parent: newHostRef.current });

        hunkIndex.current = -1;
        builtRowsRef.current = diff.rows;
        setBuildTick((tick) => tick + 1);
        const isNewView = buildSig.current !== sig;
        buildSig.current = sig;
        if (!isNewView && hadViews) {
          requestAnimationFrame(() => {
            if (oldViewRef.current) oldViewRef.current.scrollDOM.scrollTop = prevScroll;
            if (newViewRef.current) newViewRef.current.scrollDOM.scrollTop = prevScroll;
          });
        } else if (isNewView && split.hunkStarts.length) {
          scrollSplitToLine(oldViewRef.current, newViewRef.current, split.hunkStarts[0]);
          hunkIndex.current = 0;
        }
        return;
      }

      oldViewRef.current?.destroy();
      oldViewRef.current = null;
      newViewRef.current?.destroy();
      newViewRef.current = null;

      const doc =
        viewMode === "file"
          ? (diff.fileContent ?? rowsToNewText(diff))
          : diff.rows.map((r) => r.text).join("\n");

      // A refresh/refocus refetches the same content: if nothing actually
      // changed, leave the editor untouched so the reader's scroll position and
      // selection are preserved (no jump to the top).
      if (
        buildSig.current === sig &&
        viewRef.current?.state.doc.toString() === doc &&
        (viewMode === "file" || sameDiffRows(builtRowsRef.current, diff.rows))
      ) {
        buildSig.current = sig;
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
      builtRowsRef.current = viewMode === "diff" ? diff.rows : null;
      setBuildTick((t) => t + 1);

      // Focus the first change when the file/view first opens (but not on a
      // silent working-tree refresh, which keeps the same selection + mode).
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
  }, [diff, viewMode, diffLayout, selectionKey, split]);

  // The two split panes have identical row counts and fixed line heights, so
  // mirroring both scroll offsets keeps their old/new rows and columns aligned.
  useEffect(() => {
    if (viewMode !== "diff" || diffLayout !== "split") return;
    const oldScroller = oldViewRef.current?.scrollDOM;
    const newScroller = newViewRef.current?.scrollDOM;
    if (!oldScroller || !newScroller) return;

    let equalizingWidths = false;
    let equalizeFrame = 0;
    const equalizeWidths = () => {
      if (equalizingWidths || !oldViewRef.current || !newViewRef.current) return;
      equalizingWidths = true;
      const previousLeft = Math.max(oldScroller.scrollLeft, newScroller.scrollLeft);
      const sharedMax = equalizeSplitScrollWidths(oldViewRef.current, newViewRef.current);
      const restoredLeft = Math.min(previousLeft, sharedMax);
      oldScroller.scrollLeft = restoredLeft;
      newScroller.scrollLeft = restoredLeft;
      cancelAnimationFrame(equalizeFrame);
      equalizeFrame = requestAnimationFrame(() => {
        equalizingWidths = false;
      });
    };
    equalizeWidths();
    const resizeObserver = new ResizeObserver(equalizeWidths);
    resizeObserver.observe(oldScroller);
    resizeObserver.observe(newScroller);

    const sync = (from: HTMLElement, to: HTMLElement) => {
      if (equalizingWidths) return;
      if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop;
      if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
    };
    const syncOld = () => sync(oldScroller, newScroller);
    const syncNew = () => sync(newScroller, oldScroller);
    oldScroller.addEventListener("scroll", syncOld, { passive: true });
    newScroller.addEventListener("scroll", syncNew, { passive: true });
    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(equalizeFrame);
      oldScroller.removeEventListener("scroll", syncOld);
      newScroller.removeEventListener("scroll", syncNew);
    };
  }, [buildTick, diffLayout, viewMode]);

  // Tear down the editor on unmount.
  useEffect(() => {
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
      oldViewRef.current?.destroy();
      oldViewRef.current = null;
      newViewRef.current?.destroy();
      newViewRef.current = null;
      builtRowsRef.current = null;
    };
  }, []);

  // Keep the match set current and center the active hit. The CodeMirror
  // plugin decorates the visible subset, and rebuilding the editor reapplies
  // search to the new document through buildTick.
  useEffect(() => {
    if (viewMode === "diff" && diffLayout === "split") {
      const oldActive = normalizedSearchIndex < oldSearchMatchCount ? normalizedSearchIndex : -1;
      const newActive = normalizedSearchIndex >= oldSearchMatchCount
        ? normalizedSearchIndex - oldSearchMatchCount
        : -1;
      applySearchHighlights(oldViewRef.current, searchMatchRanges.old, oldActive);
      applySearchHighlights(newViewRef.current, searchMatchRanges.new, newActive);
    } else {
      applySearchHighlights(viewRef.current, searchMatchRanges.unified, normalizedSearchIndex);
    }
  }, [
    searchMatchRanges,
    normalizedSearchIndex,
    oldSearchMatchCount,
    buildTick,
    diffLayout,
    viewMode,
  ]);

  const gotoHunk = (dir: 1 | -1) => {
    if (hunks.length === 0 || viewMode !== "diff") return;
    let idx = hunkIndex.current + dir;
    if (idx < 0) idx = hunks.length - 1;
    if (idx >= hunks.length) idx = 0;
    hunkIndex.current = idx;
    const lineNo = hunks[idx];
    if (diffLayout === "split") {
      scrollSplitToLine(oldViewRef.current, newViewRef.current, lineNo);
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    if (lineNo <= view.state.doc.lines) {
      const pos = view.state.doc.line(lineNo).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    }
  };

  const openSearch = useCallback(() => {
    if (!searchOpen) {
      const activeElement = document.activeElement;
      searchReturnViewRef.current = [viewRef.current, oldViewRef.current, newViewRef.current]
        .find((view) => view?.hasFocus || (!!activeElement && view?.dom.contains(activeElement)))
        ?? getView();
    }
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [getView, searchOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    requestAnimationFrame(() => {
      (searchReturnViewRef.current ?? getView())?.focus();
      searchReturnViewRef.current = null;
    });
  }, [getView]);

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
        <div className="dv-layout-toggle" role="group" aria-label="Diff layout">
          <button
            className={diffLayout === "unified" ? "active" : ""}
            title="Unified diff view"
            aria-label="Unified layout"
            aria-pressed={diffLayout === "unified"}
            disabled={viewMode !== "diff"}
            onClick={() => setDiffLayout("unified")}
          >
            <IconDiffUnified width={14} height={14} />
          </button>
          <button
            className={diffLayout === "split" ? "active" : ""}
            title="Split diff view"
            aria-label="Split layout"
            aria-pressed={diffLayout === "split"}
            disabled={viewMode !== "diff"}
            onClick={() => setDiffLayout("split")}
          >
            <IconDiffSplit width={14} height={14} />
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
          className={"dv-editor dv-editor-unified" + (showMinimap && diffLayout === "unified" ? " has-minimap" : "")}
          ref={hostRef}
          style={{
            display: diff && !diff.binary && (viewMode === "file" || diffLayout === "unified")
              ? "block"
              : "none",
          }}
        />
        <div
          className="dv-split"
          style={{
            display: diff && !diff.binary && viewMode === "diff" && diffLayout === "split"
              ? "flex"
              : "none",
          }}
        >
          <div className="dv-split-pane dv-split-old" role="region" aria-label="Original file">
            <div className="dv-editor" ref={oldHostRef} />
          </div>
          <div className="dv-split-pane dv-split-new" role="region" aria-label="Modified file">
            <div className={"dv-editor" + (showMinimap ? " has-minimap" : "")} ref={newHostRef} />
          </div>
        </div>
        {showMinimap && diff && (
          <DiffMinimap lines={overviewLines} getView={getView} buildTick={buildTick} />
        )}
      </div>
    </div>
  );
}

function rowsToNewText(diff: DiffResult): string {
  return diff.rows.filter((r) => r.type !== "del").map((r) => r.text).join("\n");
}

function applySearchHighlights(
  view: EditorView | null,
  ranges: readonly number[],
  activeIndex: number,
): void {
  if (!view) return;
  const highlights = setSearchHighlights.of({ ranges, activeIndex });
  if (activeIndex < 0) {
    view.dispatch({ effects: highlights });
    return;
  }

  const activeFrom = ranges[activeIndex * 2];
  if (activeFrom == null) return;
  view.dispatch({
    selection: { anchor: activeFrom },
    effects: [highlights, EditorView.scrollIntoView(activeFrom, { y: "center" })],
  });
}

function scrollSplitToLine(
  oldView: EditorView | null,
  newView: EditorView | null,
  lineNo: number,
): void {
  requestAnimationFrame(() => {
    for (const view of [oldView, newView]) {
      if (!view || lineNo > view.state.doc.lines) continue;
      const pos = view.state.doc.line(lineNo).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    }
  });
}

function equalizeSplitScrollWidths(oldView: EditorView, newView: EditorView): number {
  const oldScroller = oldView.scrollDOM;
  const newScroller = newView.scrollDOM;
  oldView.contentDOM.style.minWidth = "";
  newView.contentDOM.style.minWidth = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const oldMax = oldScroller.scrollWidth - oldScroller.clientWidth;
    const newMax = newScroller.scrollWidth - newScroller.clientWidth;
    const difference = Math.abs(oldMax - newMax);
    if (difference <= 1) return Math.min(oldMax, newMax);

    const content = oldMax < newMax ? oldView.contentDOM : newView.contentDOM;
    content.style.minWidth = `${content.getBoundingClientRect().width + difference}px`;
  }

  return Math.min(
    oldScroller.scrollWidth - oldScroller.clientWidth,
    newScroller.scrollWidth - newScroller.clientWidth,
  );
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
