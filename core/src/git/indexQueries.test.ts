import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { runGit } from "./gitRunner.js";
import { conflictedPaths } from "./conflict.js";
import { unstagePaths } from "./mutate.js";
import { getStatus } from "./status.js";

const ROOT = path.join(os.tmpdir(), `gitwebui-index-queries-${randomBytes(6).toString("hex")}`);

beforeEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "user.name", "Test"]);
  await runGit(ROOT, ["config", "user.email", "t@example.com"]);
  await fs.writeFile(path.join(ROOT, "tracked.txt"), "base\n");
  await runGit(ROOT, ["add", "-A"]);
  await runGit(ROOT, ["commit", "-m", "base"]);
});
afterAll(() => fs.rm(ROOT, { recursive: true, force: true }));

describe("index query behavior", () => {
  it("matches diff conflict paths for every unmerged stage combination and index mode", async () => {
    const blob = (await runGit(ROOT, ["hash-object", "-w", "--stdin"], { input: "conflict\n" })).stdout.trim();
    const head = (await runGit(ROOT, ["rev-parse", "HEAD"])).stdout.trim();
    const records: string[] = [];
    const expected: string[] = [];
    for (const mode of ["100644", "120000", "160000"]) {
      for (let mask = 1; mask <= 7; mask += 1) {
        const name = `${mode}/conflict-${mask} [x].txt`;
        expected.push(name);
        for (let stage = 1; stage <= 3; stage += 1) {
          if (mask & (1 << (stage - 1))) {
            records.push(`${mode} ${mode === "160000" ? head : blob} ${stage}\t${name}\0`);
          }
        }
      }
    }
    await runGit(ROOT, ["update-index", "-z", "--index-info"], { input: records.join("") });

    const before = (await runGit(ROOT, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout.split("\0").filter(Boolean);
    expect(before).toEqual(expected);
    expect(await conflictedPaths(ROOT)).toEqual(before);
  });

  it("unstages a selected rename without altering unrelated unmerged index entries", async () => {
    await runGit(ROOT, ["mv", "tracked.txt", "renamed.txt"]);
    await fs.writeFile(path.join(ROOT, "renamed.txt"), "unstaged edit\n");
    const blob = (await runGit(ROOT, ["hash-object", "-w", "--stdin"], { input: "conflict\n" })).stdout.trim();
    await runGit(ROOT, ["update-index", "-z", "--index-info"], {
      input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tunmerged.txt\0`).join(""),
    });
    const unresolved = (await runGit(ROOT, ["ls-files", "--unmerged", "-z"])).stdout;
    expect((await getStatus(ROOT)).staged).toContainEqual({ path: "renamed.txt", oldPath: "tracked.txt", status: "R", staged: true });

    await unstagePaths(ROOT, ["renamed.txt"]);

    expect((await runGit(ROOT, ["ls-files", "--unmerged", "-z"])).stdout).toBe(unresolved);
    expect((await getStatus(ROOT)).staged).toEqual([]);
    expect(await fs.readFile(path.join(ROOT, "renamed.txt"), "utf8")).toBe("unstaged edit\n");
  });
});
