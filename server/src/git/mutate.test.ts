import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { deleteFile } from "./mutate.js";

const ROOT = path.join(os.tmpdir(), `gitwebui-mutate-${randomBytes(6).toString("hex")}`);

beforeEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, "sub"), { recursive: true });
});
afterAll(() => fs.rm(ROOT, { recursive: true, force: true }));

describe("deleteFile", () => {
  it("removes a file inside the repo", async () => {
    const rel = "sub/a.txt";
    await fs.writeFile(path.join(ROOT, rel), "x");
    await deleteFile(ROOT, rel);
    await expect(fs.access(path.join(ROOT, rel))).rejects.toThrow();
  });

  it("rejects paths that escape the repo root", async () => {
    // A sentinel file just outside the repo must survive the attempt.
    const outside = path.join(ROOT, "..", `sentinel-${randomBytes(4).toString("hex")}.txt`);
    await fs.writeFile(outside, "keep");
    try {
      await expect(deleteFile(ROOT, "../" + path.basename(outside))).rejects.toMatchObject({
        status: 400,
      });
      expect(await fs.readFile(outside, "utf8")).toBe("keep");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});
