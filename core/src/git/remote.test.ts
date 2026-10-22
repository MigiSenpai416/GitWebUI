import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

process.env.GITWEBUI_CONFIG_DIR = path.join(
  os.tmpdir(),
  `gitwebui-remote-test-${randomBytes(6).toString("hex")}`,
);

const { parseRemotes, repoNameFromUrl, rethrowRemoteError } = await import("./remote.js");

describe("repoNameFromUrl", () => {
  it("derives the folder name from common clone URLs", () => {
    expect(repoNameFromUrl("https://github.com/owner/my-repo.git")).toBe("my-repo");
    expect(repoNameFromUrl("https://github.com/owner/my-repo")).toBe("my-repo");
    expect(repoNameFromUrl("git@github.com:owner/My.Repo.git")).toBe("My.Repo");
    expect(repoNameFromUrl("https://example.com/a/b/deep/name.git/")).toBe("name");
  });

  it("falls back to a default when no segment is present", () => {
    expect(repoNameFromUrl("")).toBe("repository");
  });
});

describe("parseRemotes", () => {
  it("de-duplicates fetch/push lines into one entry per remote", () => {
    const out =
      "origin\thttps://github.com/me/repo.git (fetch)\n" +
      "origin\thttps://github.com/me/repo.git (push)\n" +
      "upstream\thttps://github.com/other/repo.git (fetch)\n" +
      "upstream\thttps://github.com/other/repo.git (push)\n";
    expect(parseRemotes(out)).toEqual([
      { name: "origin", url: "https://github.com/me/repo.git" },
      { name: "upstream", url: "https://github.com/other/repo.git" },
    ]);
  });

  it("returns an empty list for no remotes", () => {
    expect(parseRemotes("")).toEqual([]);
    expect(parseRemotes("\n  \n")).toEqual([]);
  });
});

describe("remote authentication errors", () => {
  it("uses 403 for missing remote credentials so the app session is preserved", async () => {
    await expect(
      rethrowRemoteError(
        new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
        null,
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        status: 403,
        message: expect.stringContaining("Connect a GitHub account"),
      }),
    );
  });

  it("uses 403 when the configured remote token is rejected", async () => {
    await expect(rethrowRemoteError(new Error("remote: Invalid username or password"), "bad-token"))
      .rejects.toThrowError(
        expect.objectContaining({
          status: 403,
          message: expect.stringContaining("Remote authentication failed"),
        }),
      );
  });

  it("names the missing workflow scope when GitHub refuses a .github/workflows push", async () => {
    const oauth = new Error(
      " ! [remote rejected] main -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\nerror: failed to push some refs to 'https://github.com/me/repo.git'",
    );
    await expect(rethrowRemoteError(oauth, "gho_token")).rejects.toThrowError(
      expect.objectContaining({
        status: 403,
        message: expect.stringContaining("workflow scope"),
      }),
    );
    const fineGrained = new Error(
      " ! [remote rejected] main -> main (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
    );
    await expect(rethrowRemoteError(fineGrained, "github_pat")).rejects.toThrowError(
      expect.objectContaining({
        status: 403,
        message: expect.stringContaining(".github/workflows"),
      }),
    );
  });

  it("preserves non-authentication Git errors", async () => {
    const error = Object.assign(new Error("remote branch does not exist"), { status: 422 });
    await expect(rethrowRemoteError(error, null)).rejects.toThrow(error);
  });
});
