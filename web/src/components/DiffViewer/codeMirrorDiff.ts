import {
  EditorView,
  ViewPlugin,
  gutter,
  GutterMarker,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";
import { EditorState, StateEffect, StateField, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { DiffRow } from "../../types";

export interface SearchHighlights {
  /** Flat, ordered [from, to, from, to, ...] document ranges. */
  ranges: readonly number[];
  activeIndex: number;
}

/** Replaces the file-search highlights currently shown in the editor. */
export const setSearchHighlights = StateEffect.define<SearchHighlights>();

const searchMatch = Decoration.mark({ class: "cm-file-search-match" });
const activeSearchMatch = Decoration.mark({ class: "cm-file-search-match cm-file-search-match-active" });
const noSearchHighlights: SearchHighlights = { ranges: [], activeIndex: -1 };
const maxVisibleSearchHighlights = 2_000;

const searchHighlightField = StateField.define<SearchHighlights>({
  create: () => noSearchHighlights,
  update(value, transaction) {
    // The viewer is read-only and replaces its entire state when the document
    // changes. Clearing here also keeps ranges safe if that ever changes.
    if (transaction.docChanged) value = noSearchHighlights;
    for (const effect of transaction.effects) {
      if (effect.is(setSearchHighlights)) value = effect.value;
    }
    return value;
  },
});

/**
 * Render highlights only for CodeMirror's drawn viewport. Match offsets remain
 * available for the full-file count/navigation, without constructing a huge
 * DecorationSet for every occurrence in a generated or minified file.
 */
const searchHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = visibleSearchDecorations(view);
    }

    update(update: ViewUpdate) {
      const searchChanged = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setSearchHighlights)),
      );
      if (searchChanged || update.docChanged || update.viewportChanged) {
        this.decorations = visibleSearchDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function visibleSearchDecorations(view: EditorView): DecorationSet {
  const { ranges, activeIndex } = view.state.field(searchHighlightField);
  if (ranges.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const count = Math.floor(ranges.length / 2);
  const visibleIndexes: number[] = [];

  for (const visible of view.visibleRanges) {
    let index = firstMatchEndingAfter(ranges, visible.from, count);
    while (index < count && visibleIndexes.length < maxVisibleSearchHighlights) {
      const from = ranges[index * 2];
      if (from >= visible.to) break;
      if (visibleIndexes.at(-1) !== index) visibleIndexes.push(index);
      index++;
    }
    if (visibleIndexes.length >= maxVisibleSearchHighlights) break;
  }

  // Always show the active result, even when a single huge/minified line has
  // more visible matches than the non-active decoration budget.
  if (
    activeIndex >= 0 &&
    activeIndex < count &&
    matchIntersectsVisibleRange(ranges, activeIndex, view.visibleRanges) &&
    !visibleIndexes.includes(activeIndex)
  ) {
    visibleIndexes.push(activeIndex);
    visibleIndexes.sort((a, b) => a - b);
  }

  for (const index of visibleIndexes) {
    builder.add(
      ranges[index * 2],
      ranges[index * 2 + 1],
      index === activeIndex ? activeSearchMatch : searchMatch,
    );
  }

  return builder.finish();
}

function matchIntersectsVisibleRange(
  ranges: readonly number[],
  index: number,
  visibleRanges: readonly { from: number; to: number }[],
): boolean {
  const from = ranges[index * 2];
  const to = ranges[index * 2 + 1];
  return visibleRanges.some((visible) => to > visible.from && from < visible.to);
}

function firstMatchEndingAfter(ranges: readonly number[], position: number, count: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle * 2 + 1] <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Lazily import the CodeMirror language for a coarse language id. */
export async function loadLanguage(lang: string): Promise<Extension | null> {
  try {
    switch (lang) {
      case "javascript":
        return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
      case "typescript":
        return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
      case "cpp":
        return (await import("@codemirror/lang-cpp")).cpp();
      case "python":
        return (await import("@codemirror/lang-python")).python();
      case "json":
        return (await import("@codemirror/lang-json")).json();
      case "markdown":
        return (await import("@codemirror/lang-markdown")).markdown();
      case "html":
        return (await import("@codemirror/lang-html")).html();
      case "css":
        return (await import("@codemirror/lang-css")).css();
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---- Diff line decorations ----------------------------------------------

const addLine = Decoration.line({ class: "cm-diff-add" });
const delLine = Decoration.line({ class: "cm-diff-del" });

/**
 * A StateField providing static per-line diff backgrounds. Because the editor
 * state is rebuilt for every diff, decorations are computed once in `create`
 * directly from the document — no view or async effect needed.
 */
export function diffDecorationField(rows: DiffRow[]): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      const builder = new RangeSetBuilder<Decoration>();
      const max = Math.min(rows.length, state.doc.lines);
      for (let i = 1; i <= max; i++) {
        const row = rows[i - 1];
        if (row.type === "context") continue;
        const line = state.doc.line(i);
        builder.add(line.from, line.from, row.type === "add" ? addLine : delLine);
      }
      return builder.finish();
    },
    update(value) {
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return field;
}

// ---- Twin line-number gutters (old / new) --------------------------------

class NumberMarker extends GutterMarker {
  constructor(private readonly n: number) {
    super();
  }
  toDOM() {
    return document.createTextNode(String(this.n));
  }
}

function numberGutter(rows: DiffRow[], side: "old" | "new"): Extension {
  return gutter({
    class: side === "old" ? "cm-gutter-old" : "cm-gutter-new",
    lineMarker(view, block) {
      const lineNo = view.state.doc.lineAt(block.from).number;
      const row = rows[lineNo - 1];
      if (!row) return null;
      const value = side === "old" ? row.oldNo : row.newNo;
      return value == null ? null : new NumberMarker(value);
    },
    lineMarkerChange: () => false,
  });
}

// ---- Hunks ---------------------------------------------------------------

/** 1-based line numbers where each hunk (run of changed rows) begins. */
export function computeHunks(rows: DiffRow[]): number[] {
  const starts: number[] = [];
  let inHunk = false;
  for (let i = 0; i < rows.length; i++) {
    const changed = rows[i].type !== "context";
    if (changed && !inHunk) starts.push(i + 1);
    inHunk = changed;
  }
  return starts;
}

// ---- Theme & syntax highlight --------------------------------------------

export const diffHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#ff7b72" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "#c9d4df" },
  { tag: [t.propertyName], color: "#79c0ff" },
  { tag: [t.function(t.variableName), t.labelName], color: "#d2a8ff" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#79c0ff" },
  { tag: [t.definition(t.name), t.separator], color: "#c9d4df" },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "#ffa657" },
  { tag: [t.operator, t.operatorKeyword], color: "#ff7b72" },
  { tag: [t.url, t.escape, t.regexp, t.link], color: "#a5d6ff" },
  { tag: [t.meta, t.comment], color: "#8b949e", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.string, t.processingInstruction, t.inserted], color: "#a5d6ff" },
  { tag: [t.bool, t.null, t.atom], color: "#79c0ff" },
  { tag: t.invalid, color: "#f85149" },
]);

export const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "var(--text)",
      height: "100%",
      fontSize: "12.5px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.5",
      overflow: "auto",
    },
    ".cm-content": { padding: "0" },
    ".cm-line": { padding: "0 12px 0 6px" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-panel)",
      color: "var(--text-faint)",
      border: "none",
      borderRight: "1px solid var(--border)",
    },
    ".cm-gutter-old, .cm-gutter-new": {
      minWidth: "52px",
      padding: "0 8px 0 4px",
      textAlign: "right",
      fontVariantNumeric: "tabular-nums",
    },
    ".cm-diff-add": { backgroundColor: "var(--diff-add-bg)" },
    ".cm-diff-del": { backgroundColor: "var(--diff-del-bg)" },
    ".cm-diff-add.cm-activeLine, .cm-diff-del.cm-activeLine": {
      backgroundColor: "inherit",
    },
  },
  { dark: true },
);

/** Extensions for the inline diff view (twin gutters + line backgrounds). */
export function diffViewExtensions(rows: DiffRow[]): Extension[] {
  return [
    numberGutter(rows, "old"),
    numberGutter(rows, "new"),
    diffDecorationField(rows),
  ];
}

/** Extensions for the plain "File View" (single number gutter). */
export function fileViewExtensions(): Extension[] {
  return [lineNumbers()];
}

export function baseExtensions(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    editorTheme,
    syntaxHighlighting(diffHighlightStyle),
    EditorView.lineWrapping,
    searchHighlightField,
    searchHighlightPlugin,
  ];
}
