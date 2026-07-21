import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { openRepo, createLocalRepo } from "./repo.js";
import { runGit } from "./gitRunner.js";

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

describe("createLocalRepo", () => {
  it("initializes a new repo on the requested default branch", async () => {
    const info = await createLocalRepo(TMP, "my-repo", "trunk", {
      name: "Test",
      email: "t@example.com",
    });
    expect(info.root).toBe(await realRoot(path.join(TMP, "my-repo")));
    expect(info.branch).toBe("trunk");
    expect(info.head).not.toBeNull(); // seeded with an initial commit
    // The .git directory exists on disk.
    await expect(fs.stat(path.join(TMP, "my-repo", ".git"))).resolves.toBeTruthy();
  });

  it("seeds a README with the repo name and commits it", async () => {
    await createLocalRepo(TMP, "seeded", "main", { name: "Test", email: "t@example.com" });
    const readme = await fs.readFile(path.join(TMP, "seeded", "README.md"), "utf8");
    expect(readme.replace(/\r/g, "")).toBe("# seeded\n");
    // Exactly one commit, and the working tree is clean.
    const root = path.join(TMP, "seeded");
    const count = (await runGit(root, ["rev-list", "--count", "HEAD"])).stdout.trim();
    expect(count).toBe("1");
    const status = (await runGit(root, ["status", "--porcelain"])).stdout.trim();
    expect(status).toBe("");
  });

  it("defaults the branch to main when none is given", async () => {
    const info = await createLocalRepo(TMP, "defaulted", "");
    expect(info.branch).toBe("main");
  });

  it("rejects a name with path separators", async () => {
    await expect(createLocalRepo(TMP, "a/b", "main")).rejects.toMatchObject({ status: 400 });
    await expect(createLocalRepo(TMP, "..", "main")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects creating where a repo already exists", async () => {
    await createLocalRepo(TMP, "dup", "main");
    await expect(createLocalRepo(TMP, "dup", "main")).rejects.toMatchObject({
      status: 400,
      message: /already exists/,
    });
  });

  it("rejects a missing parent folder", async () => {
    await expect(
      createLocalRepo(path.join(TMP, "no-such-parent"), "x", "main"),
    ).rejects.toMatchObject({ status: 400, message: /Path not found/ });
  });
});

/** openRepo normalizes to the toplevel (resolving any symlinks); mirror that. */
async function realRoot(dir: string): Promise<string> {
  return (await openRepo(dir)).root;
}
