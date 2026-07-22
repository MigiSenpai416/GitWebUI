import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { runGit } from "./gitRunner.js";
import {
  parseStashList,
  parseNotesList,
  getStashes,
  setStashNote,
  pruneStashNotes,
  stashDrop,
  STASH_NOTES_REF,
} from "./stash.js";

const FS = "\x1f";
const RS = "\x1e";

/** One line of what `git stash list --format=…` streams back. */
function record(ref: string, hash: string, date: string, subject: string, note = ""): string {
  return [ref, hash, date, subject, note].join(FS) + RS;
}

describe("parseStashList", () => {
  it("parses the record stream and extracts the index", () => {
    const out =
      record("stash@{0}", "a".repeat(40), "1700000000", "WIP on main: 1a2b3c4 Add feature") +
      "\n" +
      record("stash@{1}", "b".repeat(40), "1699999999", "On feature: custom message");
    expect(parseStashList(out)).toEqual([
      {
        index: 0,
        ref: "stash@{0}",
        hash: "a".repeat(40),
        message: "WIP on main: 1a2b3c4 Add feature",
        date: 1700000000,
        noteTitle: "",
        noteBody: "",
      },
      {
        index: 1,
        ref: "stash@{1}",
        hash: "b".repeat(40),
        message: "On feature: custom message",
        date: 1699999999,
        noteTitle: "",
        noteBody: "",
      },
    ]);
  });

  it("splits a note into its first line and the rest", () => {
    const [entry] = parseStashList(
      record("stash@{0}", "c".repeat(40), "1", "On main: x", "Auth spike\n\nHalf done.\nDo not merge.\n"),
    );
    expect(entry.noteTitle).toBe("Auth spike");
    expect(entry.noteBody).toBe("Half done.\nDo not merge.");
  });

  it("keeps a one-line note as a title with no body", () => {
    const [entry] = parseStashList(record("stash@{0}", "d".repeat(40), "1", "On main: x", "Just a name\n"));
    expect(entry).toMatchObject({ noteTitle: "Just a name", noteBody: "" });
  });

  it("returns an empty list when there are no stashes", () => {
    expect(parseStashList("")).toEqual([]);
    expect(parseStashList("\n  \n")).toEqual([]);
  });
});

describe("parseNotesList", () => {
  it("takes the annotated object from each `<note> <object>` pair", () => {
    expect(parseNotesList(`${"1".repeat(40)} ${"A".repeat(40)}\n${"2".repeat(40)} ${"b".repeat(40)}\n`)).toEqual([
      "a".repeat(40),
      "b".repeat(40),
    ]);
  });

  it("ignores blank output", () => {
    expect(parseNotesList("")).toEqual([]);
  });
});

const ROOT = path.join(os.tmpdir(), `gitwebui-stash-${randomBytes(6).toString("hex")}`);
const IDENTITY = { name: "Test", email: "t@example.com" };

async function setup(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "user.email", IDENTITY.email]);
  await runGit(ROOT, ["config", "user.name", IDENTITY.name]);
  await fs.writeFile(path.join(ROOT, "a.txt"), "one\n", "utf8");
  await runGit(ROOT, ["add", "-A"]);
  await runGit(ROOT, ["commit", "-m", "base"]);
}

/** Stash a change so there is an entry to annotate. */
async function stashSomething(text: string): Promise<void> {
  await fs.writeFile(path.join(ROOT, "a.txt"), text, "utf8");
  await runGit(ROOT, ["stash", "push", "-m", text.trim()]);
}

beforeEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await setup();
});
afterAll(() => fs.rm(ROOT, { recursive: true, force: true }));

describe("stash notes", () => {
  it("reads back a title and description without touching the stash stack", async () => {
    await stashSomething("two\n");
    await stashSomething("three\n");
    const before = await getStashes(ROOT);
    expect(before).toHaveLength(2);

    await setStashNote(ROOT, before[1].hash, {
      title: "Auth spike",
      description: "Half done.\nDo not merge.",
      identity: IDENTITY,
    });

    const after = await getStashes(ROOT);
    // Same order, same indexes, same commits — only the note is new.
    expect(after.map((s) => s.hash)).toEqual(before.map((s) => s.hash));
    expect(after[1]).toMatchObject({
      index: 1,
      noteTitle: "Auth spike",
      noteBody: "Half done.\nDo not merge.",
    });
    expect(after[0].noteTitle).toBe("");
    // git's own label is left alone.
    expect(after[1].message).toBe("On main: two");
  });

  it("stores a title on its own", async () => {
    await stashSomething("two\n");
    const [entry] = await getStashes(ROOT);
    await setStashNote(ROOT, entry.hash, { title: "Just a name", identity: IDENTITY });
    const [updated] = await getStashes(ROOT);
    expect(updated).toMatchObject({ noteTitle: "Just a name", noteBody: "" });
  });

  it("clears the note when both fields are emptied", async () => {
    await stashSomething("two\n");
    const [entry] = await getStashes(ROOT);
    await setStashNote(ROOT, entry.hash, { title: "Named", identity: IDENTITY });
    expect((await getStashes(ROOT))[0].noteTitle).toBe("Named");

    await setStashNote(ROOT, entry.hash, { title: "  ", description: "", identity: IDENTITY });
    expect((await getStashes(ROOT))[0].noteTitle).toBe("");
  });

  it("survives the stash's index shifting under it", async () => {
    await stashSomething("two\n");
    await stashSomething("three\n");
    const before = await getStashes(ROOT);
    const older = before[1];
    await setStashNote(ROOT, older.hash, { title: "Keep me", identity: IDENTITY });

    await stashDrop(ROOT, 0);

    const after = await getStashes(ROOT);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ index: 0, hash: older.hash, noteTitle: "Keep me" });
  });

  it("rejects anything that isn't an object id", async () => {
    await expect(
      setStashNote(ROOT, "--ref=refs/heads/main", { title: "x", identity: IDENTITY }),
    ).rejects.toThrow(/Invalid stash id/);
    await expect(setStashNote(ROOT, "stash@{0}", { title: "x", identity: IDENTITY })).rejects.toThrow(
      /Invalid stash id/,
    );
  });

  it("prunes notes whose stash is gone and keeps the rest", async () => {
    await stashSomething("two\n");
    await stashSomething("three\n");
    const [newer, older] = await getStashes(ROOT);
    await setStashNote(ROOT, newer.hash, { title: "Newer", identity: IDENTITY });
    await setStashNote(ROOT, older.hash, { title: "Older", identity: IDENTITY });

    await stashDrop(ROOT, 0);
    await pruneStashNotes(ROOT);

    const { stdout } = await runGit(ROOT, ["notes", `--ref=${STASH_NOTES_REF}`, "list"]);
    expect(parseNotesList(stdout)).toEqual([older.hash]);
  });

  it("prunes nothing when no note was ever written", async () => {
    await stashSomething("two\n");
    await expect(pruneStashNotes(ROOT)).resolves.toBeUndefined();
  });
});
