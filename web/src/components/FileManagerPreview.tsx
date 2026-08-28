import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { api } from "../api/client";
import type { HeadFileContent } from "../types";
import {
  baseExtensions,
  fileViewExtensions,
  findTextMatchRanges,
  loadLanguage,
  setSearchHighlights,
} from "./DiffViewer/codeMirrorDiff";
import { IconClose, IconFile, IconSearch, IconSpinner } from "./icons";

interface Props {
  path: string;
  head: string;
  shortcutsBlocked: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

export function FileManagerPreview({ path, head, shortcutsBlocked, onClose, onError }: Props) {
  const [file, setFile] = useState<HeadFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [buildTick, setBuildTick] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const currentFile = file?.head === head && file.path === path ? file : null;
  const content = currentFile?.content;
  const binary = !!currentFile?.binary;
  const oversized = !!currentFile?.tooLarge;
  const searchMatchRanges = useMemo(() => {
    if (!searchOpen || !searchQuery || buildTick === 0 || content == null || binary || oversized) return [];
    const text = viewRef.current?.state.doc.toString();
    return text == null ? [] : findTextMatchRanges(text, searchQuery);
  }, [binary, buildTick, content, oversized, searchOpen, searchQuery]);
  const searchMatchCount = searchMatchRanges.length / 2;
  const normalizedSearchIndex =
    searchMatchCount === 0
      ? -1
      : ((activeSearchIndex % searchMatchCount) + searchMatchCount) % searchMatchCount;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFile(null);
    setSearchOpen(false);
    setSearchQuery("");
    setActiveSearchIndex(0);
    setBuildTick(0);
    api
      .historyFileContent(path, head)
      .then((result) => {
        if (!cancelled) setFile(result);
      })
      .catch((cause) => {
        if (!cancelled) onError(messageOf(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [head, onError, path]);

  useEffect(() => {
    if (!hostRef.current || content == null || binary) return;
    let disposed = false;

    const build = async () => {
      const language = await loadLanguage(path, "plaintext");
      if (disposed || !hostRef.current) return;
      const state = EditorState.create({
        doc: content,
        extensions: [
          ...baseExtensions(),
          ...(language ? [language] : []),
          ...fileViewExtensions(),
        ],
      });
      if (viewRef.current) viewRef.current.setState(state);
      else viewRef.current = new EditorView({ state, parent: hostRef.current });
      setBuildTick((tick) => tick + 1);
    };

    void build();
    return () => {
      disposed = true;
    };
  }, [binary, content, path]);

  useEffect(() => {
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

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
      effects: [...effects, EditorView.scrollIntoView(activeFrom, { y: "center" })],
    });
  }, [buildTick, normalizedSearchIndex, searchMatchRanges]);

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

  const gotoSearchMatch = (direction: 1 | -1) => {
    if (searchMatchCount === 0) return;
    setActiveSearchIndex((index) => {
      const current = ((index % searchMatchCount) + searchMatchCount) % searchMatchCount;
      return (current + direction + searchMatchCount) % searchMatchCount;
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shortcutsBlocked) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        openSearch();
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeSearch, openSearch, searchOpen, shortcutsBlocked]);

  return (
    <main className="fm-preview" role="region" aria-label={`Preview ${path}`}>
      <header className="fm-preview-header">
        <button className="fm-preview-back" onClick={onClose} aria-label="Back to file list" title="Back to file list">
          ←
        </button>
        <IconFile />
        <div className="fm-preview-path" title={path}>{renderPath(path)}</div>
        <span className="fm-preview-revision">HEAD {head.slice(0, 8)}</span>
        <button className="fm-preview-find-button" onClick={openSearch} title="Find in file (Ctrl+F)">
          <IconSearch /> Find
        </button>
        <button className="fm-preview-close" onClick={onClose} aria-label="Close file preview" title="Close file preview (Esc)">
          <IconClose />
        </button>
      </header>

      {searchOpen && (
        <div className="fm-preview-find-row">
          <div className="fm-preview-find">
            <IconSearch />
            <input
              ref={searchInputRef}
              aria-label="Find in file"
              placeholder="Find in file"
              value={searchQuery}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setSearchQuery(event.currentTarget.value);
                setActiveSearchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  gotoSearchMatch(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <span className="fm-preview-find-count" aria-live="polite">
              {!searchQuery
                ? ""
                : searchMatchCount === 0
                  ? "No results"
                  : `${normalizedSearchIndex + 1} of ${searchMatchCount}`}
            </span>
            <button
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
              disabled={searchMatchCount === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => gotoSearchMatch(-1)}
            >
              ▲
            </button>
            <button
              aria-label="Next match"
              title="Next match (Enter)"
              disabled={searchMatchCount === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => gotoSearchMatch(1)}
            >
              ▼
            </button>
            <button aria-label="Close search" title="Close search (Esc)" onClick={closeSearch}>
              <IconClose />
            </button>
          </div>
        </div>
      )}

      <div className="fm-preview-body">
        {loading && <div className="fm-preview-message"><IconSpinner /> Loading file…</div>}
        {!loading && oversized && <div className="fm-preview-message">File is too large to preview (10 MB limit).</div>}
        {!loading && binary && <div className="fm-preview-message">Binary file — text preview is unavailable.</div>}
        {!loading && !oversized && !binary && content == null && <div className="fm-preview-message">File content is unavailable at this revision.</div>}
        <div className="fm-preview-editor" ref={hostRef} style={{ display: !loading && !oversized && !binary && content != null ? "block" : "none" }} />
      </div>
      <footer className="fm-preview-status">
        <span>Read-only preview</span>
        <span>{path}</span>
      </footer>
    </main>
  );
}

function renderPath(path: string): React.ReactNode {
  const parts = path.split("/");
  const name = parts.pop();
  return (
    <>
      {parts.length > 0 && <span>{parts.join("/")}/</span>}
      <strong>{name}</strong>
    </>
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
