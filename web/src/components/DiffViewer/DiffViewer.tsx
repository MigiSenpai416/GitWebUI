import { useEffect, useMemo, useRef, useState } from "react";
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
} from "./codeMirrorDiff";
import "./DiffViewer.css";

export function DiffViewer() {
  const selected = useStore((s) => s.selectedFile);
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const closeFile = useStore((s) => s.closeFile);
  const stage = useStore((s) => s.stage);
  const unstage = useStore((s) => s.unstage);
  const setError = useStore((s) => s.setError);

  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const hunkIndex = useRef<number>(-1);

  // Fetch the diff whenever the selected file changes.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    setDiff(null);
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
  }, [selected, setError]);

  const hunks = useMemo(() => (diff ? computeHunks(diff.rows) : []), [diff]);

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

      const extensions = [
        ...baseExtensions(),
        ...(langExt ? [langExt] : []),
        ...(viewMode === "file" ? fileViewExtensions() : diffViewExtensions(diff.rows)),
      ];

      const state = EditorState.create({ doc, extensions });

      if (viewRef.current) {
        viewRef.current.setState(state);
      } else {
        viewRef.current = new EditorView({ state, parent: hostRef.current });
      }
      hunkIndex.current = -1;
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

  // Keyboard: Escape closes, Alt+Down/Up navigates hunks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFile();
      else if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        gotoHunk(1);
      } else if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        gotoHunk(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunks, viewMode]);

  if (!selected) return null;

  const isWorking = selected.source !== "commit";
  const sourceLabel =
    selected.source === "staged" ? "Staged" : selected.source === "unstaged" ? "Unstaged" : "Commit";

  const onStageToggle = () => {
    if (selected.source === "unstaged") stage([selected.path]);
    else if (selected.source === "staged") unstage([selected.path]);
  };

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

      <div className="dv-body">
        {loading && <div className="dv-message">Loading diff…</div>}
        {!loading && diff?.binary && (
          <div className="dv-message">Binary file — no text diff available.</div>
        )}
        {!loading && diff && !diff.binary && diff.empty && viewMode === "diff" && (
          <div className="dv-message">No changes to display.</div>
        )}
        <div className="dv-editor" ref={hostRef} style={{ display: diff && !diff.binary ? "block" : "none" }} />
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
