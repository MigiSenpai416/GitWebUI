import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";

export type DiffOverviewLine = "add" | "del" | "both" | null;

interface Segment {
  type: Exclude<DiffOverviewLine, null>;
  top: number; // 0..1 fraction of the full document height
  height: number;
}

const MIN_THUMB_HEIGHT = 14;
const SETTLE_ATTEMPTS = 8;

interface ScrollGeometry {
  maxScroll: number;
  thumbHeight: number;
  thumbTravel: number;
}

export function diffMinimapScrollGeometry(
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
): ScrollGeometry {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const naturalThumbHeight = scrollHeight > 0
    ? trackHeight * Math.min(clientHeight / scrollHeight, 1)
    : trackHeight;
  const thumbHeight = Math.min(trackHeight, Math.max(MIN_THUMB_HEIGHT, naturalThumbHeight));
  return {
    maxScroll,
    thumbHeight,
    thumbTravel: Math.max(0, trackHeight - thumbHeight),
  };
}

export function diffMinimapScrollTop(
  fraction: number,
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
): number {
  const geometry = diffMinimapScrollGeometry(scrollHeight, clientHeight, trackHeight);
  if (geometry.maxScroll === 0 || geometry.thumbTravel === 0) return 0;
  const thumbTop = Math.max(
    0,
    Math.min(geometry.thumbTravel, fraction * trackHeight - geometry.thumbHeight / 2),
  );
  return thumbTop / geometry.thumbTravel * geometry.maxScroll;
}

/**
 * A GitKraken-style overview strip pinned to the diff's right edge. It paints a
 * green/red mark for every added/removed run at its proportional position in the
 * document, plus a thumb tracking the visible viewport. Clicking or dragging the
 * strip scrolls the editor to that spot (centered), so the whole file's changes
 * are reachable at a glance even when they're far off-screen.
 */
export function DiffMinimap({
  lines,
  getView,
  buildTick,
}: {
  lines: readonly DiffOverviewLine[];
  getView: () => EditorView | null;
  buildTick: number;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const settleFrameRef = useRef(0);
  const settleTokenRef = useRef(0);
  const measureKeyRef = useRef({});
  const [segments, setSegments] = useState<Segment[]>([]);
  const [thumb, setThumb] = useState<{ top: number; height: number }>({ top: 0, height: 1 });

  const measureThumb = useCallback((view: EditorView) => {
    const sc = view.scrollDOM;
    const trackHeight = barRef.current?.clientHeight ?? 0;
    if (!trackHeight) return;
    const geometry = diffMinimapScrollGeometry(sc.scrollHeight, sc.clientHeight, trackHeight);
    const progress = geometry.maxScroll > 0 ? sc.scrollTop / geometry.maxScroll : 0;
    setThumb({
      top: progress * geometry.thumbTravel / trackHeight,
      height: geometry.thumbHeight / trackHeight,
    });
  }, []);

  // Recompute marker positions from the live editor geometry so they line up
  // exactly with the real scroll extent (accounting for line wrapping).
  const measure = useCallback(() => {
    const view = getView();
    if (!view) return;
    const sc = view.scrollDOM;
    const total = sc.scrollHeight || 1;
    const documentLines = view.state.doc.lines;
    const segs: Segment[] = [];
    for (const run of computeRuns(lines)) {
      const startLine = Math.min(run.start, documentLines);
      const endLine = Math.min(run.end, documentLines);
      const topBlock = view.lineBlockAt(view.state.doc.line(startLine).from);
      const botBlock = view.lineBlockAt(view.state.doc.line(endLine).from);
      segs.push({
        type: run.type,
        top: topBlock.top / total,
        height: Math.max((botBlock.bottom - topBlock.top) / total, 0.003),
      });
    }
    setSegments(segs);
    measureThumb(view);
  }, [lines, getView, measureThumb]);

  useEffect(() => {
    let raf = 0;
    let cleanup = () => {};
    const attach = () => {
      const view = getView();
      if (!view) {
        raf = requestAnimationFrame(attach);
        return;
      }
      const sc = view.scrollDOM;
      const onScroll = () => measureThumb(view);
      sc.addEventListener("scroll", onScroll, { passive: true });
      const ro = new ResizeObserver(() => measure());
      ro.observe(sc);
      measure();
      // Re-measure once more after syntax highlight / wrapping reflow settles.
      raf = requestAnimationFrame(() => measure());
      cleanup = () => {
        sc.removeEventListener("scroll", onScroll);
        ro.disconnect();
      };
    };
    attach();
    return () => {
      settleTokenRef.current++;
      cancelAnimationFrame(settleFrameRef.current);
      cancelAnimationFrame(raf);
      cleanup();
    };
  }, [buildTick, measure, measureThumb]);

  const scrollToClientY = useCallback(
    (clientY: number) => {
      const view = getView();
      const bar = barRef.current;
      if (!view || !bar) return;
      const rect = bar.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const sc = view.scrollDOM;
      const token = ++settleTokenRef.current;
      cancelAnimationFrame(settleFrameRef.current);

      const targetScrollTop = () => diffMinimapScrollTop(
        f,
        sc.scrollHeight,
        sc.clientHeight,
        bar.clientHeight,
      );
      sc.scrollTop = targetScrollTop();

      const settle = (attempt: number, previousHeight: number) => {
        if (settleTokenRef.current !== token || getView() !== view) return;
        view.requestMeasure({
          key: measureKeyRef.current,
          read: () => ({
            currentScrollTop: sc.scrollTop,
            scrollHeight: sc.scrollHeight,
            scrollTop: targetScrollTop(),
          }),
          write: ({ currentScrollTop, scrollHeight, scrollTop }) => {
            if (settleTokenRef.current !== token || getView() !== view) return;
            if (Math.abs(currentScrollTop - scrollTop) > 0.5) sc.scrollTop = scrollTop;
            if (attempt + 1 < SETTLE_ATTEMPTS && scrollHeight !== previousHeight) {
              settleFrameRef.current = requestAnimationFrame(() => settle(attempt + 1, scrollHeight));
            } else if (attempt < 2) {
              settleFrameRef.current = requestAnimationFrame(() => settle(attempt + 1, scrollHeight));
            } else {
              settleFrameRef.current = requestAnimationFrame(() => {
                if (settleTokenRef.current === token && getView() === view) measure();
              });
            }
          },
        });
      };
      settle(0, sc.scrollHeight);
    },
    [getView, measure],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrollToClientY(e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (draggingRef.current) scrollToClientY(e.clientY);
  };
  const endDrag = (e: React.PointerEvent) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div
      className="dv-minimap"
      ref={barRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role="scrollbar"
      aria-label="Diff overview"
    >
      {segments.map((s, i) => (
        <div
          key={i}
          className={"dv-mm-mark " + s.type}
          style={{ top: `${s.top * 100}%`, height: `${s.height * 100}%` }}
        />
      ))}
      <div
        className="dv-mm-thumb"
        style={{ top: `${thumb.top * 100}%`, height: `${thumb.height * 100}%` }}
      />
    </div>
  );
}

/** Contiguous runs of added or removed rows, as 1-based line-number ranges. */
function computeRuns(lines: readonly DiffOverviewLine[]): Array<{
  type: Exclude<DiffOverviewLine, null>;
  start: number;
  end: number;
}> {
  const runs: Array<{
    type: Exclude<DiffOverviewLine, null>;
    start: number;
    end: number;
  }> = [];
  let cur: (typeof runs)[number] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const ty = lines[i];
    if (ty) {
      const line = i + 1;
      if (cur && cur.type === ty && cur.end === line - 1) {
        cur.end = line;
      } else {
        cur = { type: ty, start: line, end: line };
        runs.push(cur);
      }
    } else {
      cur = null;
    }
  }
  return runs;
}
