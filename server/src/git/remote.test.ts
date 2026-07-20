import { describe, it, expect } from "vitest";
import { parseRemotes, authArgs, repoNameFromUrl } from "./remote.js";

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

describe("authArgs", () => {
  it("disables credential helpers even without a token (avoids GUI prompt)", () => {
    expect(authArgs(null)).toEqual(["-c", "credential.helper="]);
  });

  it("injects a Basic auth header for a token without leaking it as a bare arg", () => {
    const args = authArgs("secret-token");
    expect(args.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    const header = args[3];
    expect(header.startsWith("http.extraHeader=Authorization: Basic ")).toBe(true);
    const b64 = header.split("Basic ")[1];
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("x-access-token:secret-token");
    // The raw token must not appear as its own argv element.
    expect(args).not.toContain("secret-token");
  });
});
