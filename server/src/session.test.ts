import { describe, it, expect, beforeEach } from "vitest";
import type { Request } from "express";
import {
  registerRepo,
  unregisterRepo,
  getRepoByRoot,
  requestedRoot,
  requireRepo,
  requireRepoRoot,
} from "./session.js";

function reqWithRoot(root?: string): Request {
  return { header: (name: string) => (name.toLowerCase() === "x-repo-root" ? root : undefined) } as unknown as Request;
}

const info = { root: "/repos/alpha", branch: "main", head: "abc123" };

describe("session repo registry", () => {
  beforeEach(() => {
    unregisterRepo("/repos/alpha");
    unregisterRepo("/repos/beta");
  });

  it("registers and resolves a repo by the request header", () => {
    registerRepo(info);
    expect(getRepoByRoot("/repos/alpha")).toEqual(info);
    expect(requireRepo(reqWithRoot("/repos/alpha"))).toEqual(info);
    expect(requireRepoRoot(reqWithRoot("/repos/alpha"))).toBe("/repos/alpha");
  });

  it("keeps repos independent so multiple tabs can be open at once", () => {
    registerRepo(info);
    registerRepo({ root: "/repos/beta", branch: "dev", head: "def456" });
    expect(requireRepo(reqWithRoot("/repos/alpha")).branch).toBe("main");
    expect(requireRepo(reqWithRoot("/repos/beta")).branch).toBe("dev");
  });

  it("throws a 409 when the header names an unopened (or missing) repo", () => {
    expect(() => requireRepo(reqWithRoot("/repos/unknown"))).toThrowError(/No repository is open/);
    expect(() => requireRepo(reqWithRoot())).toThrow();
    try {
      requireRepo(reqWithRoot());
    } catch (e) {
      expect((e as { status?: number }).status).toBe(409);
    }
  });

  it("reads a trimmed root from the header", () => {
    expect(requestedRoot(reqWithRoot("  /repos/alpha  "))).toBe("/repos/alpha");
    expect(requestedRoot(reqWithRoot())).toBe("");
  });
});
