import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { api } from "../api/client";
import { writeClipboard } from "../desktop";
import { useStore } from "../state/store";
import type { BlameResult } from "../types";
import { baseExtensions, loadLanguage } from "./DiffViewer/codeMirrorDiff";
import { blameViewExtensions, commitColor } from "./blameCodeMirror";
import { IconBlame, IconClose, IconRefresh, IconSpinner } from "./icons";
import "./BlameView.css";

interface Props {
  path: string;
  revision?: string;
  onClose: () => void;
  onError: (message: string) => void;
}

export function BlameView({ path, revision, onClose, onError }: Props) {
  const setNotice = useStore((state) => state.setNotice);
  const [result, setResult] = useState<BlameResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedLine, setSelectedLine] = useState(1);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    api.blame(path, revision)
      .then((next) => {
        if (generation !== loadGeneration.current) return;
        setResult(next);
        setSelectedLine(next.lines[0]?.lineNumber ?? 1);
      })
      .catch((cause) => {
        if (generation !== loadGeneration.current) return;
        setResult(null);
        onError(messageOf(cause));
      })
      .finally(() => generation === loadGeneration.current && setLoading(false));
  }, [onError, path, revision]);

  useEffect(() => {
    load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const lines = result?.lines ?? [];
  const commits = useMemo(
    () => new Map((result?.commits ?? []).map((commit) => [commit.hash, commit])),
    [result],
  );
  const selected = lines.find((line) => line.lineNumber === selectedLine) ?? lines[0];
  const selectedCommit = selected ? commits.get(selected.commitHash) ?? null : null;
  const commitLineCount = selected
    ? lines.reduce((count, line) => count + Number(line.commitHash === selected.commitHash), 0)
    : 0;
  const committed = (result?.commits ?? []).filter((commit) => !commit.uncommitted);
  const authorCount = new Set(committed.map((commit) => `${commit.author}\0${commit.email}`)).size;
  const uncommittedCount = lines.reduce(
    (count, line) => count + Number(commits.get(line.commitHash)?.uncommitted),
    0,
  );

  useEffect(() => {
    if (!result || lines.length === 0 || !hostRef.current) return;
    let disposed = false;
    const build = async () => {
      const language = await loadLanguage(path, "plaintext");
      if (disposed || !hostRef.current) return;
      const state = EditorState.create({
        doc: lines.map((line) => line.text).join("\n"),
        extensions: [
          ...baseExtensions(false),
          ...(language ? [language] : []),
          ...blameViewExtensions(lines, commits, setSelectedLine),
        ],
      });
      if (viewRef.current) viewRef.current.setState(state);
      else viewRef.current = new EditorView({ state, parent: hostRef.current });
    };
    void build();
    return () => { disposed = true; };
  }, [commits, lines, path, result]);

  useEffect(() => {
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

  const copyHash = async () => {
    if (!selectedCommit || selectedCommit.uncommitted) return;
    try {
      await writeClipboard(selectedCommit.hash);
      setNotice("Copied commit ID.");
    } catch (cause) {
      onError(messageOf(cause));
    }
  };

  return (
    <main className="blame-view" role="region" aria-label={`Git blame for ${path}`}>
      <header className="blame-header">
        <button className="blame-back" onClick={onClose} aria-label="Back to file list" title="Back to file list">
          ←
        </button>
        <span className="blame-header-icon"><IconBlame /></span>
        <div className="blame-heading">
          <strong>{fileName(path)}</strong>
          <span title={path}>{path}</span>
        </div>
        {result && (
          <div className="blame-summary" aria-label="Blame summary">
            <span>{lines.length} line{lines.length === 1 ? "" : "s"}</span>
            <span>{committed.length} commit{committed.length === 1 ? "" : "s"}</span>
            <span>{authorCount} author{authorCount === 1 ? "" : "s"}</span>
            {uncommittedCount > 0 && <span className="working">{uncommittedCount} uncommitted</span>}
            {result.snapshot === "head" && <span className="head">HEAD snapshot</span>}
            {result.snapshot === "revision" && <span className="head">Commit {result.revision?.slice(0, 8)}</span>}
          </div>
        )}
        <button className="blame-refresh" onClick={() => load()} disabled={loading} aria-label="Refresh blame" title="Refresh blame">
          {loading ? <IconSpinner /> : <IconRefresh />}
        </button>
        <button className="blame-close" onClick={onClose} aria-label="Close blame" title="Close blame">
          <IconClose />
        </button>
      </header>

      <div className="blame-body">
        <section className="blame-source" aria-label="Annotated source">
          <div className="blame-code-guide">
            <strong>Click a code line, or use Up and Down, to see who changed it and why.</strong>
            <span>The colored blame gutter groups neighboring lines from the same commit.</span>
          </div>
          <div className="blame-editor-wrap">
            {loading && !result && <div className="blame-message"><IconSpinner /> Asking Git who changed each line…</div>}
            {!loading && result && lines.length === 0 && <div className="blame-message">This file is empty, so there are no lines to attribute.</div>}
            <div className="blame-editor" ref={hostRef} style={{ display: result && lines.length > 0 ? "block" : "none" }} />
          </div>
        </section>

        <aside className="blame-details" aria-label="Selected line details">
          {result?.snapshot === "head" && (
            <div className="blame-snapshot-note">
              This file is missing from the working tree, so blame shows its last committed version at HEAD.
            </div>
          )}
          {result?.snapshot === "revision" && (
            <div className="blame-snapshot-note">
              Blame is pinned to this historical file image at commit {result.revision?.slice(0, 8)}.
            </div>
          )}
          {selected && selectedCommit ? (
            <>
              <div className="blame-detail-heading">
                <span className="blame-detail-dot" style={{ background: commitColor(selectedCommit) }} />
                <div>
                  <span>Line {selected.lineNumber}</span>
                  <strong>{selectedCommit.summary}</strong>
                </div>
              </div>
              {selectedCommit.uncommitted ? (
                <div className="blame-explanation working">
                  This line differs from HEAD. Commit it before Git can permanently attribute it to an author.
                </div>
              ) : selectedCommit.boundary ? (
                <div className="blame-explanation">
                  This is the oldest reachable change Git can trace for the line.
                </div>
              ) : null}
              <dl className="blame-meta">
                <div><dt>Author</dt><dd>{selectedCommit.author}{selectedCommit.email && <small>{selectedCommit.email}</small>}</dd></div>
                {!selectedCommit.uncommitted && (
                  <div><dt>Authored</dt><dd>{formatDate(selectedCommit.authorTime)}<small>{formatAge(selectedCommit.authorTime, false)}</small></dd></div>
                )}
                {!selectedCommit.uncommitted && selectedCommit.committer &&
                  (selectedCommit.committer !== selectedCommit.author || selectedCommit.committerEmail !== selectedCommit.email) && (
                    <div><dt>Committed by</dt><dd>{selectedCommit.committer}{selectedCommit.committerEmail && <small>{selectedCommit.committerEmail}</small>}</dd></div>
                  )}
                <div><dt>Origin</dt><dd><code>{selected.originalPath}:{selected.originalLine}</code></dd></div>
                {selected.originalPath !== path && (
                  <div><dt>File history</dt><dd>Git traced this line from <code>{selected.originalPath}</code>.</dd></div>
                )}
                {selected.previousPath && selected.previousPath !== selected.originalPath && (
                  <div><dt>Previous path</dt><dd><code>{selected.previousPath}</code></dd></div>
                )}
                <div><dt>Impact</dt><dd>{commitLineCount} line{commitLineCount === 1 ? "" : "s"} in this file come from this change.</dd></div>
              </dl>
              {!selectedCommit.uncommitted && (
                <button className="blame-hash" onClick={() => void copyHash()} title="Copy full commit ID">
                  <span>Commit</span><code>{selectedCommit.hash}</code><b>Copy</b>
                </button>
              )}
            </>
          ) : (
            <div className="blame-detail-empty">Select a line to understand where it came from.</div>
          )}
          <div className="blame-help">
            <strong>How to read blame</strong>
            <p>Each line points to the most recent commit that changed it. Neighboring lines with the same color belong to the same change.</p>
            <p>Blame explains origin, not fault—it is a starting point for understanding why code exists.</p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function formatAge(seconds: number, uncommitted: boolean): string {
  if (uncommitted) return "Now";
  if (!seconds) return "Unknown";
  const days = Math.max(0, Math.floor((Date.now() - seconds * 1000) / 86_400_000));
  if (days === 0) return "Today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function formatDate(seconds: number): string {
  if (!seconds) return "Unknown date";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
