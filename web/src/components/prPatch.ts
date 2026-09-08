export interface PrPatchLine {
  text: string;
  oldLine?: number;
  newLine?: number;
}

export function parsePrPatch(patch: string): PrPatchLine[] {
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  return patch.split("\n").map((text) => {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldLeft = Number(header[2] ?? 1);
      newLeft = Number(header[4] ?? 1);
      return { text };
    }
    if (text.startsWith("\\")) return { text };
    if (text.startsWith("+") && newLeft > 0) { newLeft--; return { text, newLine: newLine++ }; }
    if (text.startsWith("-") && oldLeft > 0) { oldLeft--; return { text, oldLine: oldLine++ }; }
    if (text.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
      oldLeft--; newLeft--;
      return { text, oldLine: oldLine++, newLine: newLine++ };
    }
    oldLeft = 0;
    newLeft = 0;
    return { text };
  });
}
