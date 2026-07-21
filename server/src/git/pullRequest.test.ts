import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { runGit } from "./gitRunner.js";
import { findPullRequestTemplates, readPullRequestTemplate, githubRemotes } from "./pullRequest.js";

const ROOT = path.join(os.tmpdir(), `gitwebui-pr-${randomBytes(6).toString("hex")}`);

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(ROOT, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

beforeEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
});
afterAll(() => fs.rm(ROOT, { recursive: true, force: true }));

describe("findPullRequestTemplates", () => {
  it("finds nothing in a repo without templates", async () => {
    await write("README.md", "# repo\n");
    expect(await findPullRequestTemplates(ROOT)).toEqual([]);
  });

  it("finds the single-file form in .github, the root, and docs", async () => {
    await write(".github/pull_request_template.md", "github\n");
    await write("PULL_REQUEST_TEMPLATE.md", "root\n");
    await write("docs/pull_request_template.txt", "docs\n");
    const found = await findPullRequestTemplates(ROOT);
    expect(found.map((t) => t.path.toLowerCase()).sort()).toEqual([
      ".github/pull_request_template.md",
      "docs/pull_request_template.txt",
      "pull_request_template.md",
    ]);
  });

  it("lists every template in a PULL_REQUEST_TEMPLATE directory", async () => {
    await write(".github/PULL_REQUEST_TEMPLATE/bug.md", "bug\n");
    await write(".github/PULL_REQUEST_TEMPLATE/feature.md", "feature\n");
    await write(".github/PULL_REQUEST_TEMPLATE/notes.png", "not a template\n");
    const found = await findPullRequestTemplates(ROOT);
    expect(found.map((t) => t.path)).toEqual([
      ".github/PULL_REQUEST_TEMPLATE/bug.md",
      ".github/PULL_REQUEST_TEMPLATE/feature.md",
    ]);
    expect(found[0].name).toBe("bug.md");
  });
});

describe("readPullRequestTemplate", () => {
  it("reads a discovered template", async () => {
    await write(".github/pull_request_template.md", "## Summary\n");
    expect(await readPullRequestTemplate(ROOT, ".github/pull_request_template.md")).toBe(
      "## Summary\n",
    );
  });

  it("refuses any path that isn't a discovered template", async () => {
    await write(".github/pull_request_template.md", "## Summary\n");
    await write("secrets.env", "TOKEN=1\n");
    await expect(readPullRequestTemplate(ROOT, "secrets.env")).rejects.toThrow(
      "Unknown pull request template",
    );
    await expect(readPullRequestTemplate(ROOT, "../../etc/passwd")).rejects.toThrow(
      "Unknown pull request template",
    );
  });
});

describe("githubRemotes", () => {
  it("keeps GitHub remotes (origin first) and drops the rest", async () => {
    await runGit(ROOT, ["init", "-b", "main"]);
    await runGit(ROOT, ["remote", "add", "upstream", "https://github.com/up/repo.git"]);
    await runGit(ROOT, ["remote", "add", "origin", "git@github.com:me/repo.git"]);
    await runGit(ROOT, ["remote", "add", "mirror", "https://gitlab.com/me/repo.git"]);

    const remotes = await githubRemotes(ROOT);
    expect(remotes.map((r) => [r.remote, r.owner, r.repo])).toEqual([
      ["origin", "me", "repo"],
      ["upstream", "up", "repo"],
    ]);
  });
});
