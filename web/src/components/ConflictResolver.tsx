import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import {
  countConflicts,
  parseConflicts,
  reconstruct,
  chosenLines,
  type ConflictPart,
  type Side,
} from "./conflictParse";
import { IconCheck, IconClose, IconExternal, IconSparkle, IconWarning } from "./icons";
import "./ConflictResolver.css";

/**
 * Three-way merge editor for a single conflicted file, aligned like GitKraken:
 * A (ours) and B (theirs) sit side by side over the Output result, all three on
 * one shared row grid so every line lines up and the panes scroll together.
 * Each conflict has an A/B pick in either pane — keep one side, the other, or
 * both. Save writes the Output and, when every conflict is picked, stages the
 * file as resolved.
 */
export function ConflictResolver() {
  const path = useStore((s) => s.conflictPath);
  const data = useStore((s) => s.conflictData);
  const loading = useStore((s) => s.conflictLoading);
  const close = useStore((s) => s.closeConflict);
  const save = useStore((s) => s.saveResolution);
  const setNotice = useStore((s) => s.setNotice);
  const setError = useStore((s) => s.setError);

  const parts = useMemo(() => (data ? parseConflicts(data.merged) : []), [data]);
  const total = useMemo(() => countConflicts(parts), [parts]);

  const [choices, setChoices] = useState<Side[][]>([]);
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);

  const topRef = useRef<HTMLDivElement>(null);
  const outRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  useEffect(() => {
    setChoices(Array.from({ length: total }, () => []));
    setCurrent(0);
  }, [data, total]);

  const rows = useMemo(() => buildGrid(parts, choices), [parts, choices]);

  const scrollToConflict = (idx: number) => {
    const el = topRef.current?.querySelector<HTMLElement>(`[data-ch="${idx}"]`);
    if (!el || !topRef.current) return;
    const top = Math.max(0, el.offsetTop - 48);
    topRef.current.scrollTop = top;
    if (outRef.current) outRef.current.scrollTop = top;
  };

  // Focus the first conflict once the grid renders.
  useEffect(() => {
    if (data && total > 0) requestAnimationFrame(() => scrollToConflict(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, close]);

  // Keep the Output pane's vertical scroll locked to the A/B pane and back.
  const syncScroll = (from: "top" | "out") => {
    if (syncing.current) return;
    const src = from === "top" ? topRef.current : outRef.current;
    const dst = from === "top" ? outRef.current : topRef.current;
    if (!src || !dst) return;
    syncing.current = true;
    dst.scrollTop = src.scrollTop;
    dst.scrollLeft = src.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  const toggle = (idx: number, side: Side) => {
    setChoices((prev) => {
      const next = prev.map((c) => [...c]);
      const cur = next[idx] ?? [];
      next[idx] = cur.includes(side) ? cur.filter((s) => s !== side) : [...cur, side];
      return next;
    });
  };

  const goto = (dir: 1 | -1) => {
    if (total === 0) return;
    let idx = current + dir;
    if (idx < 0) idx = total - 1;
    if (idx >= total) idx = 0;
    setCurrent(idx);
    scrollToConflict(idx);
  };

  const allResolved = total === 0 || choices.every((c) => c.length > 0);
  const resolvedCount = choices.filter((c) => c.length > 0).length;

  const onSave = async () => {
    if (!path) return;
    setBusy(true);
    try {
      await save(path, reconstruct(parts, choices), allResolved);
      if (!allResolved) {
        setNotice(`Saved — ${total - resolvedCount} conflict(s) still unresolved.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the resolution.");
    } finally {
      setBusy(false);
    }
  };

  if (!path) return null;

  return (
    <div className="conflict-resolver">
      <div className="cr-header">
        <IconWarning width={16} height={16} className="cr-warn-icon" />
        <span className="cr-path" title={path}>
          {path}
        </span>
        <span className="cr-count">
          ({total} conflict{total === 1 ? "" : "s"})
        </span>
        <div className="cr-spacer" />
        <button className="cr-tool" onClick={() => setNotice("AI auto-resolve isn't available yet.")}>
          <IconSparkle width={14} height={14} /> Auto-resolve with AI
        </button>
        <button
          className="cr-tool"
          onClick={() => setNotice("An external merge tool isn't configured yet.")}
        >
          <IconExternal width={14} height={14} /> Open in external merge tool
        </button>
        <button className="cr-save" onClick={onSave} disabled={busy || loading}>
          {busy ? "Saving…" : allResolved ? "Save & mark resolved" : "Save"}
        </button>
        <button className="cr-close" title="Close (Esc)" onClick={close} disabled={busy}>
          <IconClose />
        </button>
      </div>

      {loading || !data ? (
        <div className="cr-loading">Loading conflict…</div>
      ) : (
        <>
          <div className="cr-sides">
            <div className="cr-sides-head">
              <div className="cr-pane-head">
                <span className="cr-badge ours">A</span>
                <span className="cr-pane-label" title={data.oursLabel}>
                  {data.oursLabel}
                </span>
              </div>
              <div className="cr-pane-head">
                <span className="cr-badge theirs">B</span>
                <span className="cr-pane-label" title={data.theirsLabel}>
                  {data.theirsLabel}
                </span>
              </div>
            </div>
            <div className="cr-grid" ref={topRef} onScroll={() => syncScroll("top")}>
              {rows.map((r, i) => (
                <TopRow key={i} row={r} choices={choices} onToggle={toggle} />
              ))}
            </div>
          </div>

          <div className="cr-output">
            <div className="cr-output-head">
              <span className="cr-output-title">Output</span>
              <div className="cr-nav">
                <span className="cr-nav-label">
                  {total === 0 ? "no conflicts" : `conflict ${current + 1} of ${total}`}
                </span>
                <button onClick={() => goto(-1)} disabled={total === 0} title="Previous conflict">
                  ▲
                </button>
                <button onClick={() => goto(1)} disabled={total === 0} title="Next conflict">
                  ▼
                </button>
              </div>
            </div>
            <div className="cr-grid cr-out-grid" ref={outRef} onScroll={() => syncScroll("out")}>
              {rows.map((r, i) => (
                <OutRow key={i} row={r} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Aligned grid model --------------------------------------------------

type Cell = { no: number; text: string } | null;

interface GridRow {
  kind: "text" | "header" | "conflict";
  a: Cell;
  b: Cell;
  out: Cell;
  /** Conflict index for header/conflict rows. */
  cidx?: number;
  /** True on a conflict row whose output side has content (for coloring). */
  outSide?: Side | null;
  unresolved?: boolean;
}

/**
 * Flatten the parsed parts + current choices into one row grid shared by all
 * three panes. Each conflict becomes a header row plus `max(ours, theirs,
 * output)` content rows, with the shorter columns padded by blank cells so
 * every pane lines up row-for-row.
 */
function buildGrid(parts: ConflictPart[], choices: Side[][]): GridRow[] {
  const rows: GridRow[] = [];
  let aNo = 0;
  let bNo = 0;
  let oNo = 0;
  let ci = -1;

  for (const part of parts) {
    if (part.kind === "text") {
      for (const line of part.lines) {
        aNo++;
        bNo++;
        oNo++;
        rows.push({
          kind: "text",
          a: { no: aNo, text: line },
          b: { no: bNo, text: line },
          out: { no: oNo, text: line },
        });
      }
      continue;
    }

    ci++;
    const idx = ci;
    const choice = choices[idx] ?? [];
    const ours = part.ours ?? [];
    const theirs = part.theirs ?? [];
    const outLines = choice.length > 0 ? chosenLines(part, choice) : [];
    const unresolved = choice.length === 0;

    rows.push({ kind: "header", a: null, b: null, out: null, cidx: idx, unresolved });

    const height = Math.max(ours.length, theirs.length, outLines.length, 1);
    for (let k = 0; k < height; k++) {
      const a: Cell = k < ours.length ? { no: ++aNo, text: ours[k] } : null;
      const b: Cell = k < theirs.length ? { no: ++bNo, text: theirs[k] } : null;
      const out: Cell = k < outLines.length ? { no: ++oNo, text: outLines[k] } : null;
      // Which side produced this output line, for tinting.
      let outSide: Side | null = null;
      if (out) {
        const firstSideLen = choice[0] === "ours" ? ours.length : theirs.length;
        outSide = k < firstSideLen ? choice[0] : choice[1] ?? choice[0];
      }
      rows.push({ kind: "conflict", a, b, out, cidx: idx, outSide, unresolved });
    }
  }
  return rows;
}

function TopRow({
  row,
  choices,
  onToggle,
}: {
  row: GridRow;
  choices: Side[][];
  onToggle: (idx: number, side: Side) => void;
}) {
  if (row.kind === "header") {
    const idx = row.cidx!;
    const ourOn = choices[idx]?.includes("ours") ?? false;
    const theirOn = choices[idx]?.includes("theirs") ?? false;
    return (
      <div className="cr-row cr-hrow" data-ch={idx}>
        <button
          className={"cr-cell cr-pick ours" + (ourOn ? " on" : "")}
          onClick={() => onToggle(idx, "ours")}
          title={ourOn ? "Remove side A" : "Keep side A"}
        >
          <span className="cr-box">{ourOn && <IconCheck width={11} height={11} />}</span>
          Conflict {idx + 1}
        </button>
        <button
          className={"cr-cell cr-pick theirs" + (theirOn ? " on" : "")}
          onClick={() => onToggle(idx, "theirs")}
          title={theirOn ? "Remove side B" : "Keep side B"}
        >
          <span className="cr-box">{theirOn && <IconCheck width={11} height={11} />}</span>
          Conflict {idx + 1}
        </button>
      </div>
    );
  }
  const conflict = row.kind === "conflict";
  return (
    <div className="cr-row">
      <CodeCell cell={row.a} cls={conflict ? (row.a ? "ours" : "absent") : ""} />
      <CodeCell cell={row.b} cls={conflict ? (row.b ? "theirs" : "absent") : ""} />
    </div>
  );
}

function OutRow({ row }: { row: GridRow }) {
  if (row.kind === "header") {
    return (
      <div className="cr-row cr-hrow cr-out-hrow" data-ch={row.cidx}>
        <div className={"cr-cell cr-out-label" + (row.unresolved ? " unresolved" : " resolved")}>
          Conflict {(row.cidx ?? 0) + 1}
          {row.unresolved ? " — pick A and/or B" : " — resolved"}
        </div>
      </div>
    );
  }
  let cls = "";
  if (row.kind === "conflict") {
    if (row.unresolved) cls = "out-cell unresolved";
    else cls = "out-cell " + (row.out ? row.outSide ?? "" : "absent");
  }
  return (
    <div className="cr-row">
      <CodeCell cell={row.out} cls={cls} full />
    </div>
  );
}

function CodeCell({ cell, cls, full }: { cell: Cell; cls?: string; full?: boolean }) {
  return (
    <div className={"cr-cell" + (full ? " cr-cell-full" : "") + (cls ? " " + cls : "")}>
      <span className="cr-ln">{cell ? cell.no : ""}</span>
      <span className="cr-tx">{cell ? (cell.text === "" ? " " : cell.text) : ""}</span>
    </div>
  );
}
