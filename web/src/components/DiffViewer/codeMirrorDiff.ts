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
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import type { DiffRow } from "../../types";

export interface SplitDiffRow extends DiffRow {
  placeholder?: boolean;
}

export interface SplitDiffRows {
  oldRows: SplitDiffRow[];
  newRows: SplitDiffRow[];
  oldHighlights: IntralineRange[][];
  newHighlights: IntralineRange[][];
  hunkStarts: number[];
}

export interface SearchHighlights {
  /** Flat, ordered [from, to, from, to, ...] document ranges. */
  ranges: readonly number[];
  activeIndex: number;
}

export interface IntralineRange {
  from: number;
  to: number;
}

export interface IntralineDiff {
  ranges: IntralineRange[][];
  pairs: Array<[number, number]>;
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

/** Lazily load the CodeMirror language matching a file path. */
export async function loadLanguage(path: string, fallbackLanguage: string): Promise<Extension | null> {
  const filename = path.split(/[\\/]/).pop() ?? path;
  const description =
    LanguageDescription.matchFilename(languages, filename) ??
    LanguageDescription.matchLanguageName(languages, fallbackLanguage, false);
  if (!description) return null;

  try {
    return await description.load();
  } catch {
    return null;
  }
}

// ---- Diff line decorations ----------------------------------------------

const addLine = Decoration.line({ class: "cm-diff-add" });
const delLine = Decoration.line({ class: "cm-diff-del" });
const addText = Decoration.mark({ class: "cm-diff-add-text" });
const delText = Decoration.mark({ class: "cm-diff-del-text" });
const placeholderLine = Decoration.line({ class: "cm-diff-placeholder" });
const maxIntralineTextLength = 20_000;
const maxLineComparisonCells = 40_000;
const maxDiffComparisonCells = 1_000_000;
const maxDiffComparisonPairs = 2_000;
const maxDiffComparisonText = 2_000_000;
const maxLineAlignmentCells = 2_500;
const maxLineFingerprintCount = 2_000;
const maxLineAlignmentLookahead = 8;
const minLineSimilarity = 0.2;
const minLineSimilarityGain = 0.05;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A StateField providing static per-line diff backgrounds. Because the editor
 * state is rebuilt for every diff, decorations are computed once in `create`
 * directly from the document — no view or async effect needed.
 */
export function diffDecorationField(
  rows: readonly DiffRow[],
  highlights: readonly (readonly IntralineRange[])[] = computeIntralineRanges(rows),
): Extension {
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
  return [field, intralineDecorationField(rows, highlights)];
}

function intralineDecorationField(
  rows: readonly DiffRow[],
  ranges: readonly (readonly IntralineRange[])[],
): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      const builder = new RangeSetBuilder<Decoration>();
      const max = Math.min(rows.length, state.doc.lines);
      for (let i = 1; i <= max; i++) {
        const row = rows[i - 1];
        const decoration = row.type === "add" ? addText : row.type === "del" ? delText : null;
        if (!decoration) continue;
        const line = state.doc.line(i);
        for (const range of ranges[i - 1]) {
          builder.add(line.from + range.from, line.from + range.to, decoration);
        }
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

/** Character ranges that differ inside paired removed and added lines. */
export function computeIntralineRanges(
  rows: readonly DiffRow[],
  counterparts?: readonly DiffRow[],
): IntralineRange[][] {
  if (counterparts) {
    return pairedIntralineRanges(rows, counterparts, comparisonBudget()).left;
  }
  return computeIntralineDiff(rows).ranges;
}

export function computeIntralineDiff(rows: readonly DiffRow[]): IntralineDiff {
  const ranges = rows.map(() => [] as IntralineRange[]);
  const pairs: Array<[number, number]> = [];
  const budget = comparisonBudget();

  let index = 0;
  while (index < rows.length) {
    if (rows[index].type === "context") {
      index++;
      continue;
    }

    const deleted: ChangedLine[] = [];
    const added: ChangedLine[] = [];
    while (index < rows.length && rows[index].type !== "context") {
      (rows[index].type === "del" ? deleted : added).push({
        index,
        text: rows[index].text,
        owner: "left",
      });
      index++;
    }

    const linePairs = budget.remainingPairs > 0 && budget.remainingText > 0
      ? pairChangedLines(deleted, added)
      : pairChangedLinesByPosition(deleted, added);
    for (const [oldLine, newLine] of linePairs) {
      pairs.push([oldLine.index, newLine.index]);
      if (budget.remainingPairs <= 0 || budget.remainingText <= 0) continue;
      const changed = changedTextRanges(oldLine.text, newLine.text, budget);
      ranges[oldLine.index] = changed.old;
      ranges[newLine.index] = changed.new;
    }
  }

  return { ranges, pairs };
}

interface ChangedLine {
  index: number;
  text: string;
  owner: "left" | "right";
}

interface ComparisonBudget {
  remainingCells: number;
  remainingPairs: number;
  remainingText: number;
}

function comparisonBudget(): ComparisonBudget {
  return {
    remainingCells: maxDiffComparisonCells,
    remainingPairs: maxDiffComparisonPairs,
    remainingText: maxDiffComparisonText,
  };
}

function pairedIntralineRanges(
  leftRows: readonly DiffRow[],
  rightRows: readonly DiffRow[],
  budget: ComparisonBudget,
): { left: IntralineRange[][]; right: IntralineRange[][] } {
  const left = leftRows.map(() => [] as IntralineRange[]);
  const right = rightRows.map(() => [] as IntralineRange[]);
  const max = Math.min(leftRows.length, rightRows.length);
  let index = 0;

  while (index < max) {
    if (leftRows[index].type === "context" && rightRows[index].type === "context") {
      index++;
      continue;
    }

    const deleted: ChangedLine[] = [];
    const added: ChangedLine[] = [];
    while (
      index < max &&
      (leftRows[index].type !== "context" || rightRows[index].type !== "context")
    ) {
      for (const [row, owner] of [
        [leftRows[index], "left"],
        [rightRows[index], "right"],
      ] as const) {
        if (row.type === "del") deleted.push({ index, text: row.text, owner });
        else if (row.type === "add") added.push({ index, text: row.text, owner });
      }
      index++;
    }

    if (budget.remainingPairs <= 0 || budget.remainingText <= 0) continue;
    for (const [oldLine, newLine] of pairChangedLines(deleted, added)) {
      const changed = changedTextRanges(oldLine.text, newLine.text, budget);
      (oldLine.owner === "left" ? left : right)[oldLine.index] = changed.old;
      (newLine.owner === "left" ? left : right)[newLine.index] = changed.new;
    }
  }

  return { left, right };
}

function pairChangedLines(
  deleted: readonly ChangedLine[],
  added: readonly ChangedLine[],
): Array<[ChangedLine, ChangedLine]> {
  if (deleted.length === 0 || added.length === 0) return [];
  if (deleted.length + added.length > maxLineFingerprintCount) {
    return pairChangedLinesByPosition(deleted, added);
  }
  const deletedFingerprints = deleted.map((line) => lineFingerprint(line.text));
  const addedFingerprints = added.map((line) => lineFingerprint(line.text));
  if (deleted.length * added.length > maxLineAlignmentCells) {
    return pairChangedLinesInWindow(
      deleted,
      added,
      deletedFingerprints,
      addedFingerprints,
    );
  }

  const width = added.length + 1;
  const scores = new Float32Array(deleted.length * added.length);
  const totals = new Float32Array((deleted.length + 1) * width);

  for (let oldIndex = deleted.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = added.length - 1; newIndex >= 0; newIndex--) {
      const score = fingerprintSimilarity(
        deletedFingerprints[oldIndex],
        addedFingerprints[newIndex],
      );
      scores[oldIndex * added.length + newIndex] = score;
      const paired = score >= minLineSimilarity
        ? score + totals[(oldIndex + 1) * width + newIndex + 1]
        : -1;
      totals[oldIndex * width + newIndex] = Math.max(
        paired,
        totals[(oldIndex + 1) * width + newIndex],
        totals[oldIndex * width + newIndex + 1],
      );
    }
  }

  const similarPairs: Array<[number, number]> = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < deleted.length && newIndex < added.length) {
    const score = scores[oldIndex * added.length + newIndex];
    const paired = score + totals[(oldIndex + 1) * width + newIndex + 1];
    const best = totals[oldIndex * width + newIndex];
    if (score >= minLineSimilarity && Math.abs(paired - best) < 0.0001) {
      similarPairs.push([oldIndex++, newIndex++]);
    } else if (
      totals[(oldIndex + 1) * width + newIndex] >=
      totals[oldIndex * width + newIndex + 1]
    ) {
      oldIndex++;
    } else {
      newIndex++;
    }
  }

  const pairs: Array<[ChangedLine, ChangedLine]> = [];
  let oldStart = 0;
  let newStart = 0;
  for (const [oldEnd, newEnd] of [...similarPairs, [deleted.length, added.length] as const]) {
    if (oldEnd - oldStart === newEnd - newStart) {
      for (let offset = 0; offset < oldEnd - oldStart; offset++) {
        pairs.push([deleted[oldStart + offset], added[newStart + offset]]);
      }
    }
    if (oldEnd < deleted.length && newEnd < added.length) {
      pairs.push([deleted[oldEnd], added[newEnd]]);
    }
    oldStart = oldEnd + 1;
    newStart = newEnd + 1;
  }

  return pairs;
}

function pairChangedLinesByPosition(
  deleted: readonly ChangedLine[],
  added: readonly ChangedLine[],
): Array<[ChangedLine, ChangedLine]> {
  const pairCount = Math.min(deleted.length, added.length);
  return Array.from({ length: pairCount }, (_, index) => [deleted[index], added[index]]);
}

function pairChangedLinesInWindow(
  deleted: readonly ChangedLine[],
  added: readonly ChangedLine[],
  deletedFingerprints: readonly LineFingerprint[],
  addedFingerprints: readonly LineFingerprint[],
): Array<[ChangedLine, ChangedLine]> {
  const pairs: Array<[ChangedLine, ChangedLine]> = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < deleted.length && newIndex < added.length) {
    const current = fingerprintSimilarity(
      deletedFingerprints[oldIndex],
      addedFingerprints[newIndex],
    );

    let oldMatch = -1;
    let oldScore = -1;
    for (
      let candidate = oldIndex + 1;
      candidate < Math.min(deleted.length, oldIndex + maxLineAlignmentLookahead + 1);
      candidate++
    ) {
      const score = fingerprintSimilarity(
        deletedFingerprints[candidate],
        addedFingerprints[newIndex],
      );
      if (
        score >= minLineSimilarity &&
        score > current + minLineSimilarityGain &&
        score > oldScore
      ) {
        oldMatch = candidate;
        oldScore = score;
      }
    }

    let newMatch = -1;
    let newScore = -1;
    for (
      let candidate = newIndex + 1;
      candidate < Math.min(added.length, newIndex + maxLineAlignmentLookahead + 1);
      candidate++
    ) {
      const score = fingerprintSimilarity(
        deletedFingerprints[oldIndex],
        addedFingerprints[candidate],
      );
      if (
        score >= minLineSimilarity &&
        score > current + minLineSimilarityGain &&
        score > newScore
      ) {
        newMatch = candidate;
        newScore = score;
      }
    }

    if (oldMatch >= 0 || newMatch >= 0) {
      if (oldScore >= newScore) oldIndex = oldMatch;
      else newIndex = newMatch;
      continue;
    }

    if (current >= minLineSimilarity) {
      pairs.push([deleted[oldIndex++], added[newIndex++]]);
      continue;
    }

    const oldRemaining = deleted.length - oldIndex;
    const newRemaining = added.length - newIndex;
    if (oldRemaining === newRemaining) {
      pairs.push([deleted[oldIndex++], added[newIndex++]]);
    } else if (oldRemaining > newRemaining) {
      oldIndex++;
    } else {
      newIndex++;
    }
  }

  return pairs;
}

interface LineFingerprint {
  grams: Map<string, number>;
  gramCount: number;
  words: Map<string, number>;
  wordCount: number;
}

function lineFingerprint(text: string): LineFingerprint {
  const sample = text.length <= 512 ? text : `${text.slice(0, 256)}\0${text.slice(-256)}`;
  const size = sample.length > 1 ? 2 : 1;
  const grams = new Map<string, number>();
  let gramCount = 0;
  for (let index = 0; index <= sample.length - size; index++) {
    const gram = sample.slice(index, index + size);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
    gramCount++;
  }
  const words = new Map<string, number>();
  let wordCount = 0;
  for (const match of sample.matchAll(/[\p{L}\p{N}_]+/gu)) {
    words.set(match[0], (words.get(match[0]) ?? 0) + 1);
    wordCount++;
  }
  return { grams, gramCount, words, wordCount };
}

function fingerprintSimilarity(left: LineFingerprint, right: LineFingerprint): number {
  return Math.max(
    multisetSimilarity(left.grams, left.gramCount, right.grams, right.gramCount),
    multisetSimilarity(left.words, left.wordCount, right.words, right.wordCount),
  );
}

function multisetSimilarity(
  left: Map<string, number>,
  leftCount: number,
  right: Map<string, number>,
  rightCount: number,
): number {
  if (leftCount === 0 || rightCount === 0) return 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const [gram, count] of smaller) {
    shared += Math.min(count, larger.get(gram) ?? 0);
  }
  return (shared * 2) / (leftCount + rightCount);
}

interface TextToken extends IntralineRange {
  text: string;
}

function changedTextRanges(
  oldText: string,
  newText: string,
  budget: ComparisonBudget,
): { old: IntralineRange[]; new: IntralineRange[] } {
  if (oldText === newText) return { old: [], new: [] };
  if (budget.remainingPairs <= 0) return { old: [], new: [] };
  budget.remainingPairs--;

  const textLength = oldText.length + newText.length;
  if (textLength > maxIntralineTextLength) {
    budget.remainingText = Math.max(0, budget.remainingText - maxIntralineTextLength);
    return { old: [], new: [] };
  }
  if (textLength > budget.remainingText) {
    budget.remainingText = 0;
    return { old: [], new: [] };
  }
  budget.remainingText -= textLength;

  const oldTokens = textTokens(oldText);
  const newTokens = textTokens(newText);
  const cells = (oldTokens.length + 1) * (newTokens.length + 1);
  if (cells > maxLineComparisonCells || cells > budget.remainingCells) {
    return graphemeSafeChangedRanges(
      oldText,
      newText,
      trimmedChangedRange(oldText, newText, 0, 0),
    );
  }
  budget.remainingCells -= cells;

  const width = newTokens.length + 1;
  const lengths = new Uint16Array(cells);
  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex--) {
      const offset = oldIndex * width + newIndex;
      lengths[offset] = oldTokens[oldIndex].text === newTokens[newIndex].text
        ? lengths[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(lengths[(oldIndex + 1) * width + newIndex], lengths[offset + 1]);
    }
  }

  const matches: Array<[number, number]> = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
    if (oldTokens[oldIndex].text === newTokens[newIndex].text) {
      matches.push([oldIndex++, newIndex++]);
    } else if (
      lengths[(oldIndex + 1) * width + newIndex] >= lengths[oldIndex * width + newIndex + 1]
    ) {
      oldIndex++;
    } else {
      newIndex++;
    }
  }
  matches.push([oldTokens.length, newTokens.length]);

  const oldRanges: IntralineRange[] = [];
  const newRanges: IntralineRange[] = [];
  let oldStart = 0;
  let newStart = 0;
  for (const [oldEnd, newEnd] of matches) {
    if (oldStart < oldEnd || newStart < newEnd) {
      const oldFrom = oldStart < oldTokens.length ? oldTokens[oldStart].from : oldText.length;
      const oldTo = oldEnd > oldStart ? oldTokens[oldEnd - 1].to : oldFrom;
      const newFrom = newStart < newTokens.length ? newTokens[newStart].from : newText.length;
      const newTo = newEnd > newStart ? newTokens[newEnd - 1].to : newFrom;
      const changed = trimmedChangedRange(
        oldText.slice(oldFrom, oldTo),
        newText.slice(newFrom, newTo),
        oldFrom,
        newFrom,
      );
      oldRanges.push(...changed.old);
      newRanges.push(...changed.new);
    }
    oldStart = oldEnd + 1;
    newStart = newEnd + 1;
  }

  return graphemeSafeChangedRanges(
    oldText,
    newText,
    { old: oldRanges, new: newRanges },
  );
}

function textTokens(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  for (const match of text.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu)) {
    tokens.push({ text: match[0], from: match.index, to: match.index + match[0].length });
  }
  return tokens;
}

function trimmedChangedRange(
  oldText: string,
  newText: string,
  oldOffset: number,
  newOffset: number,
): { old: IntralineRange[]; new: IntralineRange[] } {
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length) {
    const codePoint = oldText.codePointAt(prefix);
    if (codePoint !== newText.codePointAt(prefix)) break;
    prefix += codePoint! > 0xffff ? 2 : 1;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > prefix && newEnd > prefix) {
    const oldStart = previousCodePointStart(oldText, oldEnd);
    const newStart = previousCodePointStart(newText, newEnd);
    if (oldText.codePointAt(oldStart) !== newText.codePointAt(newStart)) break;
    oldEnd = oldStart;
    newEnd = newStart;
  }

  const oldFrom = oldOffset + prefix;
  const oldTo = oldOffset + oldEnd;
  const newFrom = newOffset + prefix;
  const newTo = newOffset + newEnd;
  return {
    old: oldFrom < oldTo ? [{ from: oldFrom, to: oldTo }] : [],
    new: newFrom < newTo ? [{ from: newFrom, to: newTo }] : [],
  };
}

function graphemeSafeChangedRanges(
  oldText: string,
  newText: string,
  ranges: { old: IntralineRange[]; new: IntralineRange[] },
): { old: IntralineRange[]; new: IntralineRange[] } {
  return {
    old: expandRangesToGraphemeBoundaries(oldText, ranges.old),
    new: expandRangesToGraphemeBoundaries(newText, ranges.new),
  };
}

function expandRangesToGraphemeBoundaries(
  text: string,
  ranges: readonly IntralineRange[],
): IntralineRange[] {
  const expanded: IntralineRange[] = [];
  for (const range of ranges) {
    const next = expandToGraphemeBoundaries(text, range.from, range.to);
    if (!next) continue;
    const previous = expanded.at(-1);
    if (previous && next.from <= previous.to) previous.to = Math.max(previous.to, next.to);
    else expanded.push(next);
  }
  return expanded;
}

function expandToGraphemeBoundaries(
  text: string,
  from: number,
  to: number,
): IntralineRange | null {
  if (from >= to) return null;
  let expandedFrom = 0;
  let expandedTo = text.length;
  for (const segment of graphemeSegmenter.segment(text)) {
    const start = segment.index;
    const end = start + segment.segment.length;
    if (start <= from && from < end) expandedFrom = start;
    if (start < to && to <= end) {
      expandedTo = end;
      break;
    }
  }
  return { from: expandedFrom, to: expandedTo };
}

function previousCodePointStart(text: string, index: number): number {
  const last = text.charCodeAt(index - 1);
  if (last < 0xdc00 || last > 0xdfff || index < 2) return index - 1;
  const first = text.charCodeAt(index - 2);
  return first >= 0xd800 && first <= 0xdbff ? index - 2 : index - 1;
}

function placeholderDecorationField(rows: SplitDiffRow[]): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      const builder = new RangeSetBuilder<Decoration>();
      const max = Math.min(rows.length, state.doc.lines);
      for (let i = 1; i <= max; i++) {
        if (!rows[i - 1].placeholder) continue;
        const line = state.doc.line(i);
        builder.add(line.from, line.from, placeholderLine);
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

/** Build line-aligned old/new documents for the side-by-side diff view. */
export function splitDiffRows(
  rows: DiffRow[],
  intraline = computeIntralineDiff(rows),
): SplitDiffRows {
  const highlights = intraline.ranges;
  const pairedLines = new Map(intraline.pairs);
  const oldRows: SplitDiffRow[] = [];
  const newRows: SplitDiffRow[] = [];
  const oldHighlights: IntralineRange[][] = [];
  const newHighlights: IntralineRange[][] = [];
  const hunkStarts: number[] = [];
  let index = 0;

  while (index < rows.length) {
    if (rows[index].type === "context") {
      oldRows.push(rows[index]);
      newRows.push(rows[index]);
      oldHighlights.push([]);
      newHighlights.push([]);
      index++;
      continue;
    }

    hunkStarts.push(oldRows.length + 1);
    const deleted: Array<{
      row: DiffRow;
      highlights: readonly IntralineRange[];
      sourceIndex: number;
    }> = [];
    const added: Array<{
      row: DiffRow;
      highlights: readonly IntralineRange[];
      sourceIndex: number;
    }> = [];
    while (index < rows.length && rows[index].type !== "context") {
      const row = rows[index];
      const entry = { row, highlights: highlights[index] ?? [], sourceIndex: index };
      if (row.type === "del") deleted.push(entry);
      else added.push(entry);
      index++;
    }

    const addedIndexes = new Map(added.map((entry, line) => [entry.sourceIndex, line]));
    const pairs: Array<[number, number]> = [];
    for (let line = 0; line < deleted.length; line++) {
      const addedIndex = pairedLines.get(deleted[line].sourceIndex);
      const pairedLine = addedIndex == null ? undefined : addedIndexes.get(addedIndex);
      if (pairedLine != null) pairs.push([line, pairedLine]);
    }
    let oldLine = 0;
    let newLine = 0;
    const append = (
      oldEntry?: { row: DiffRow; highlights: readonly IntralineRange[] },
      newEntry?: { row: DiffRow; highlights: readonly IntralineRange[] },
    ) => {
      oldRows.push(oldEntry?.row ?? emptySplitRow());
      newRows.push(newEntry?.row ?? emptySplitRow());
      oldHighlights.push(oldEntry ? [...oldEntry.highlights] : []);
      newHighlights.push(newEntry ? [...newEntry.highlights] : []);
    };

    for (const [oldPair, newPair] of pairs) {
      while (oldLine < oldPair) append(deleted[oldLine++]);
      while (newLine < newPair) append(undefined, added[newLine++]);
      append(deleted[oldLine++], added[newLine++]);
    }
    while (oldLine < deleted.length) append(deleted[oldLine++]);
    while (newLine < added.length) append(undefined, added[newLine++]);
  }

  return { oldRows, newRows, oldHighlights, newHighlights, hunkStarts };
}

export function sameDiffRows(left: readonly DiffRow[] | null, right: readonly DiffRow[]): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (
      a.type !== b.type ||
      a.oldNo !== b.oldNo ||
      a.newNo !== b.newNo ||
      a.noNewline !== b.noNewline
    ) {
      return false;
    }
  }
  return true;
}

function emptySplitRow(): SplitDiffRow {
  return { type: "context", oldNo: null, newNo: null, text: "", placeholder: true };
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
      fontVariantLigatures: "none",
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
    ".cm-diff-add-text": { backgroundColor: "var(--diff-add-highlight)" },
    ".cm-diff-del-text": { backgroundColor: "var(--diff-del-highlight)" },
    ".cm-diff-add.cm-activeLine, .cm-diff-del.cm-activeLine": {
      backgroundColor: "inherit",
    },
  },
  { dark: true },
);

/** Extensions for the inline diff view (twin gutters + line backgrounds). */
export function diffViewExtensions(
  rows: DiffRow[],
  highlights: readonly (readonly IntralineRange[])[] = computeIntralineRanges(rows),
): Extension[] {
  return [
    numberGutter(rows, "old"),
    numberGutter(rows, "new"),
    diffDecorationField(rows, highlights),
  ];
}

/** Extensions for one side of the line-aligned side-by-side diff view. */
export function splitDiffViewExtensions(
  rows: SplitDiffRow[],
  highlights: readonly (readonly IntralineRange[])[],
  side: "old" | "new",
): Extension[] {
  return [
    EditorView.contentAttributes.of({
      "aria-label": side === "old" ? "Original file" : "Modified file",
    }),
    numberGutter(rows, side),
    diffDecorationField(rows, highlights),
    placeholderDecorationField(rows),
  ];
}

/** Extensions for the plain "File View" (single number gutter). */
export function fileViewExtensions(): Extension[] {
  return [lineNumbers()];
}

export function baseExtensions(wrapLines = true): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: "0" }),
    editorTheme,
    syntaxHighlighting(diffHighlightStyle),
    ...(wrapLines ? [EditorView.lineWrapping] : []),
    searchHighlightField,
    searchHighlightPlugin,
  ];
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
