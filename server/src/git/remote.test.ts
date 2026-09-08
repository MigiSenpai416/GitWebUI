import { describe, it, expect } from "vitest";
import { parseRemotes, repoNameFromUrl, rethrowRemoteError } from "./remote.js";

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
  it("uses 403 for missing remote credentials so the app session is preserved", () => {
    expect(() =>
      rethrowRemoteError(
        new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
        null,
      ),
    ).toThrowError(
      expect.objectContaining({
        status: 403,
        message: expect.stringContaining("Connect a GitHub account"),
      }),
    );
  });

  it("uses 403 when the configured remote token is rejected", () => {
    expect(() => rethrowRemoteError(new Error("remote: Invalid username or password"), "bad-token"))
      .toThrowError(
        expect.objectContaining({
          status: 403,
          message: expect.stringContaining("Remote authentication failed"),
        }),
      );
  });

  it("preserves non-authentication Git errors", () => {
    const error = Object.assign(new Error("remote branch does not exist"), { status: 422 });
    expect(() => rethrowRemoteError(error, null)).toThrow(error);
  });
});
