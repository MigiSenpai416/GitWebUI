import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { BlameCommit, BlameLine } from "../types";

export const setSelectedBlameLine = StateEffect.define<number>();

const selectedLineField = StateField.define<number>({
  create: () => 1,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSelectedBlameLine)) value = effect.value;
    }
    return value;
  },
});

class BlameMarker extends GutterMarker {
  constructor(
    private readonly commit: BlameCommit,
    private readonly color: string,
    private readonly showLabel: boolean,
  ) {
    super();
  }

  eq(other: BlameMarker): boolean {
    return this.commit.hash === other.commit.hash && this.showLabel === other.showLabel;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("div");
    marker.className = `cm-blame-marker${this.showLabel ? " labelled" : ""}`;
    marker.style.setProperty("--blame-color", this.color);
    marker.title = this.commit.uncommitted
      ? "Uncommitted working-tree line"
      : `${this.commit.shortHash} · ${this.commit.author}\n${this.commit.summary}`;

    const rail = document.createElement("span");
    rail.className = "cm-blame-rail";
    marker.appendChild(rail);
    if (this.showLabel) {
      const hash = document.createElement("span");
      hash.className = "cm-blame-hash";
      hash.textContent = this.commit.shortHash;
      const author = document.createElement("span");
      author.className = "cm-blame-author";
      author.textContent = this.commit.uncommitted ? "" : this.commit.author;
      marker.append(hash, author);
    }
    return marker;
  }
}

/** CodeMirror extensions that turn a normal file view into an annotated blame view. */
export function blameViewExtensions(
  lines: BlameLine[],
  commits: Map<string, BlameCommit>,
  onSelectLine: (lineNumber: number) => void,
): Extension[] {
  const chunkOffsets = blameChunkOffsets(lines);
  const select = (view: EditorView, lineNumber: number) => {
    if (lineNumber < 1 || lineNumber > lines.length) return;
    const position = view.state.doc.line(lineNumber).from;
    view.dispatch({
      selection: { anchor: position },
      effects: setSelectedBlameLine.of(lineNumber),
    });
    onSelectLine(lineNumber);
  };
  return [
    EditorView.contentAttributes.of({ "aria-label": "Blame annotated source" }),
    selectedLineField,
    gutter({
      class: "cm-blame-gutter",
      renderEmptyElements: true,
      lineMarker(view, block) {
        const lineNumber = view.state.doc.lineAt(block.from).number;
        const line = lines[lineNumber - 1];
        const commit = line ? commits.get(line.commitHash) : null;
        if (!commit) return null;
        // Repeat long-running chunk labels periodically so context remains
        // visible after scrolling far away from the chunk's first line.
        const showLabel = chunkOffsets[lineNumber - 1] % 14 === 0;
        return new BlameMarker(commit, commitColor(commit), showLabel);
      },
      lineMarkerChange: () => false,
      domEventHandlers: {
        mousedown(view, block, event) {
          if (event instanceof MouseEvent && event.button !== 0) return false;
          select(view, view.state.doc.lineAt(block.from).number);
          return true;
        },
      },
    }),
    lineNumbers(),
    blameLineDecorations(lines, commits),
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
        const current = view.state.doc.lineAt(view.state.selection.main.head).number;
        const next = Math.max(
          1,
          Math.min(view.state.doc.lines, current + (event.key === "ArrowDown" ? 1 : -1)),
        );
        select(view, next);
        return true;
      },
      mousedown(event, view) {
        if (event.button !== 0) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position == null) return false;
        select(view, view.state.doc.lineAt(position).number);
        return false;
      },
    }),
  ];
}

/** Zero-based offset of each line within its contiguous commit chunk. */
export function blameChunkOffsets(lines: BlameLine[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    if (index === 0 || lines[index - 1].commitHash !== lines[index].commitHash) offset = 0;
    offsets.push(offset++);
  }
  return offsets;
}

function blameLineDecorations(
  lines: BlameLine[],
  commits: Map<string, BlameCommit>,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = visibleBlameLines(view, lines, commits);
      }

      update(update: ViewUpdate) {
        const selectionChanged = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(setSelectedBlameLine)),
        );
        if (selectionChanged || update.viewportChanged || update.docChanged) {
          this.decorations = visibleBlameLines(update.view, lines, commits);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function visibleBlameLines(
  view: EditorView,
  lines: BlameLine[],
  commits: Map<string, BlameCommit>,
): DecorationSet {
  const selected = view.state.field(selectedLineField);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    let line = view.state.doc.lineAt(range.from);
    while (line.from <= range.to) {
      const blameLine = lines[line.number - 1];
      const commit = blameLine ? commits.get(blameLine.commitHash) : null;
      if (commit) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            class: `cm-blame-code-line${line.number === selected ? " selected" : ""}${commit.uncommitted ? " uncommitted" : ""}`,
            attributes: { style: `--blame-color: ${commitColor(commit)}` },
          }),
        );
      }
      if (line.to >= range.to || line.number >= view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return builder.finish();
}

export function commitColor(commit: BlameCommit): string {
  if (commit.uncommitted) return "#d29922";
  const seed = parseInt(commit.hash.slice(0, 8), 16);
  return `hsl(${seed % 360} 58% 57%)`;
}
