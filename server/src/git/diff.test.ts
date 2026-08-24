import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDiff } from "./diff.js";
import { runGit } from "./gitRunner.js";

const ROOT = path.join(os.tmpdir(), `gitwebui-diff-${randomBytes(6).toString("hex")}`);

beforeEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "user.name", "Test"]);
  await runGit(ROOT, ["config", "user.email", "test@example.com"]);
});

afterAll(() => fs.rm(ROOT, { recursive: true, force: true }));

describe("getDiff", () => {
  it("treats a filename containing pathspec metacharacters as literal", async () => {
    for (const name of ["[ab].txt", "a.txt", "b.txt"]) {
      await fs.writeFile(path.join(ROOT, name), `${name} base\n`, "utf8");
    }
    await runGit(ROOT, ["add", "-A"]);
    await runGit(ROOT, ["commit", "-m", "base"]);
    for (const name of ["[ab].txt", "a.txt", "b.txt"]) {
      await fs.writeFile(path.join(ROOT, name), `${name} changed\n`, "utf8");
    }

    const diff = await getDiff(ROOT, "unstaged", "[ab].txt");

    expect(diff.oldPath).toBeNull();
    expect(diff.fileContent).toBe("[ab].txt changed\n");
    expect(diff.rows.filter((row) => row.type === "add").map((row) => row.text)).toEqual([
      "[ab].txt changed",
    ]);
    expect(diff.rows.map((row) => row.text).join("\n")).not.toContain("a.txt changed");
    expect(diff.rows.map((row) => row.text).join("\n")).not.toContain("b.txt changed");
  });
});
