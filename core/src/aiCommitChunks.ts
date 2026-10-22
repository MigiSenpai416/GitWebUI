interface CommitData {
  diff: string;
  files: unknown[];
  untracked: { path: string; kind: string; content: string | null }[];
}

export interface CommitPart {
  kind: "diff" | "untracked" | "status" | "summary";
  header?: string;
  hunk?: string;
  title?: string;
  index?: number;
  offset?: number;
  lineType?: "addition" | "deletion" | "context" | "metadata";
  text: string;
}

export function commitParts(context: CommitData): CommitPart[] {
  const parts: CommitPart[] = [];
  for (const file of context.diff.split(/(?=^diff --git )/m).filter(Boolean)) {
    const [header, ...hunks] = file.split(/(?=^@@ )/m);
    if (!hunks.length) parts.push({ kind: "diff", header, text: "" });
    for (const hunk of hunks) {
      const end = hunk.indexOf("\n") + 1;
      parts.push({ kind: "diff", header, hunk: hunk.slice(0, end), text: hunk.slice(end) });
    }
  }
  for (const file of context.untracked) {
    parts.push({ kind: "untracked", header: JSON.stringify({ path: file.path, kind: file.kind }), text: file.content ?? "" });
  }
  for (const file of context.files) parts.push({ kind: "status", text: JSON.stringify(file) });
  return parts;
}

export function chunkParts(parts: CommitPart[], budget: number): CommitPart[][] | null {
  const groups: CommitPart[][] = [];
  let group: CommitPart[] = [];
  let bytes = 2;
  const add = (part: CommitPart) => {
    const size = Buffer.byteLength(JSON.stringify(part)) + 1;
    if (bytes + size > budget && group.length) {
      groups.push(group);
      group = [];
      bytes = 2;
    }
    group.push(part);
    bytes += size;
  };
  for (const part of parts) {
    if (Buffer.byteLength(JSON.stringify(part)) + 3 <= budget) {
      add(part);
      continue;
    }
    if (!part.text.length) return null;
    let start = 0;
    while (start < part.text.length) {
      let lineType = start === 0 ? part.lineType : undefined;
      const lineStart = part.text.lastIndexOf("\n", start - 1) + 1;
      if (part.kind === "diff" && start > lineStart) {
        const prefix = part.text[lineStart];
        lineType = lineStart === 0 && part.lineType ? part.lineType
          : prefix === "+" ? "addition" : prefix === "-" ? "deletion" : prefix === " " ? "context" : "metadata";
      }
      const fragment = { ...part, offset: (part.offset ?? 0) + start, lineType, text: "" };
      let low = start;
      let high = Math.min(part.text.length, start + budget);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        fragment.text = part.text.slice(start, mid);
        if (Buffer.byteLength(JSON.stringify(fragment)) + 3 <= budget) low = mid;
        else high = mid - 1;
      }
      let end = low;
      if (end < part.text.length) {
        const newline = part.text.lastIndexOf("\n", end - 1);
        if (newline >= start) end = newline + 1;
        else if (/[\uD800-\uDBFF]/.test(part.text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(part.text[end])) end--;
      }
      if (end <= start) return null;
      fragment.text = part.text.slice(start, end);
      add(fragment);
      start = end;
    }
  }
  if (group.length) groups.push(group);
  return groups;
}
