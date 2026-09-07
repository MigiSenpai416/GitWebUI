import { describe, expect, it } from "vitest";
import { countConflicts, parseConflicts, reconstruct, type Side } from "./conflictParse";

for (const eol of ["\n", "\r\n"] as const) {
  for (const diff3 of [false, true]) {
    describe(`${eol === "\n" ? "LF" : "CRLF"} ${diff3 ? "diff3" : "standard"} conflicts`, () => {
      const input = [
        "before", "<<<<<<< HEAD", "ours one", "ours two",
        ...(diff3 ? ["||||||| base", "original"] : []),
        "=======", "theirs one", ">>>>>>> incoming", "after", "",
      ].join(eol);
      const cases: { name: string; choice: Side[]; selected: string[] }[] = [
        { name: "A only", choice: ["ours"], selected: ["ours one", "ours two"] },
        { name: "B only", choice: ["theirs"], selected: ["theirs one"] },
        { name: "A then B", choice: ["ours", "theirs"], selected: ["ours one", "ours two", "theirs one"] },
        { name: "B then A", choice: ["theirs", "ours"], selected: ["theirs one", "ours one", "ours two"] },
      ];
      for (const { name, choice, selected } of cases) {
        it(`preserves context and line endings for ${name}`, () => {
          const parts = parseConflicts(input);
          expect(countConflicts(parts)).toBe(1);
          expect(reconstruct(parts, [choice])).toBe(["before", ...selected, "after", ""].join(eol));
        });
      }
      it("preserves both sides and line endings when saved unresolved", () => {
        const saved = reconstruct(parseConflicts(input), [[]]);
        expect(saved).toBe([
          "before", "<<<<<<< HEAD", "ours one", "ours two",
          "=======", "theirs one", ">>>>>>> incoming", "after", "",
        ].join(eol));
        expect(reconstruct(parseConflicts(saved), [["theirs"]])).toBe(["before", "theirs one", "after", ""].join(eol));
      });
    });
  }
  it(`resolves separate ${JSON.stringify(eol)} conflicts independently, including an empty side`, () => {
    const input = [
      "before", "<<<<<<< HEAD", "=======", "added", ">>>>>>> incoming",
      "between", "<<<<<<< HEAD", "kept", "=======", "other", ">>>>>>> incoming", "after", "",
    ].join(eol);
    const parts = parseConflicts(input);
    expect(countConflicts(parts)).toBe(2);
    expect(reconstruct(parts, [["ours"], ["theirs"]])).toBe(["before", "between", "other", "after", ""].join(eol));
  });
}
