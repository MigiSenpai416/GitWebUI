/**
 * Parse a file containing git conflict markers into ordered parts: runs of
 * unchanged text interleaved with conflict blocks. Handles both the default
 * marker style and diff3/zdiff3 (which adds a `|||||||` base section).
 *
 *   <<<<<<< HEAD
 *   ...ours...
 *   ||||||| base           (diff3 only)
 *   ...base...
 *   =======
 *   ...theirs...
 *   >>>>>>> other
 */
export interface ConflictPart {
  kind: "text" | "conflict";
  /** Lines for a text part (empty for a conflict part). */
  lines: string[];
  ours?: string[];
  theirs?: string[];
  base?: string[];
}

export function parseConflicts(text: string): ConflictPart[] {
  const lines = text.split("\n");
  const parts: ConflictPart[] = [];
  let textBuf: string[] = [];
  const flush = () => {
    if (textBuf.length) {
      parts.push({ kind: "text", lines: textBuf });
      textBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("<<<<<<<")) {
      flush();
      const ours: string[] = [];
      const theirs: string[] = [];
      const base: string[] = [];
      i++;
      while (i < lines.length && !startsMarker(lines[i], "|||||||") && !startsMarker(lines[i], "=======")) {
        ours.push(lines[i]);
        i++;
      }
      let hasBase = false;
      if (i < lines.length && startsMarker(lines[i], "|||||||")) {
        hasBase = true;
        i++;
        while (i < lines.length && !startsMarker(lines[i], "=======")) {
          base.push(lines[i]);
          i++;
        }
      }
      if (i < lines.length && startsMarker(lines[i], "=======")) i++;
      while (i < lines.length && !startsMarker(lines[i], ">>>>>>>")) {
        theirs.push(lines[i]);
        i++;
      }
      if (i < lines.length && startsMarker(lines[i], ">>>>>>>")) i++;
      parts.push({ kind: "conflict", lines: [], ours, theirs, ...(hasBase ? { base } : {}) });
    } else {
      textBuf.push(line);
      i++;
    }
  }
  flush();
  return parts;
}

// A marker is the token at line start, either alone or followed by a space+label.
function startsMarker(line: string, token: string): boolean {
  return line === token || line.startsWith(token + " ");
}

export function countConflicts(parts: ConflictPart[]): number {
  return parts.reduce((n, p) => n + (p.kind === "conflict" ? 1 : 0), 0);
}

/** The chosen lines for one conflict, in the picked order (ours/theirs). */
export function chosenLines(part: ConflictPart, choice: Side[]): string[] {
  const out: string[] = [];
  for (const side of choice) {
    out.push(...(side === "ours" ? part.ours ?? [] : part.theirs ?? []));
  }
  return out;
}

export type Side = "ours" | "theirs";

/**
 * Rebuild the file text from the parts and per-conflict choices. An unresolved
 * conflict (empty choice) is re-emitted with standard markers so the saved file
 * stays a faithful, still-conflicted file rather than silently dropping a side.
 */
export function reconstruct(parts: ConflictPart[], choices: Side[][]): string {
  const out: string[] = [];
  let ci = 0;
  for (const part of parts) {
    if (part.kind === "text") {
      out.push(...part.lines);
    } else {
      const choice = choices[ci] ?? [];
      ci++;
      if (choice.length > 0) {
        out.push(...chosenLines(part, choice));
      } else {
        out.push("<<<<<<< HEAD", ...(part.ours ?? []), "=======", ...(part.theirs ?? []), ">>>>>>> incoming");
      }
    }
  }
  return out.join("\n");
}
