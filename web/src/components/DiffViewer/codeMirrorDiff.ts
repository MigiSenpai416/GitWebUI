import { EditorView, gutter, GutterMarker, lineNumbers } from "@codemirror/view";
import { EditorState, StateField, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { DiffRow } from "../../types";

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
  ];
}
