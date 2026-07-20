import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { openRepo } from "./repo.js";

const TMP = path.join(os.tmpdir(), `gitwebui-repo-${randomBytes(6).toString("hex")}`);

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
});
afterAll(() => fs.rm(TMP, { recursive: true, force: true }));

describe("openRepo error handling", () => {
  it("rejects an empty path with a 400", async () => {
    await expect(openRepo("   ")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a garbage / non-existent path without spawning git", async () => {
    await expect(openRepo("just some random text")).rejects.toMatchObject({
      status: 400,
      message: /Path not found/,
    });
  });

  it("rejects a file (not a folder)", async () => {
    const file = path.join(TMP, "a-file.txt");
    await fs.writeFile(file, "hi");
    await expect(openRepo(file)).rejects.toMatchObject({ status: 400, message: /Not a folder/ });
  });

  it("rejects a real folder that is not a git repository", async () => {
    await expect(openRepo(TMP)).rejects.toMatchObject({
      status: 400,
      message: /Not a git repository/,
    });
  });
});
