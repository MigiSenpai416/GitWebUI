import { describe, it, expect, beforeEach } from "vitest";
import {
  registerRepo,
  unregisterRepo,
  getRepoByRoot,
  requireRepo,
  requireRepoRoot,
} from "./session.js";

const info = { root: "/repos/alpha", branch: "main", head: "abc123" };

describe("session repo registry", () => {
  beforeEach(() => {
    unregisterRepo("/repos/alpha");
    unregisterRepo("/repos/beta");
  });

  it("registers and resolves a repo by its root", () => {
    registerRepo(info);
    expect(getRepoByRoot("/repos/alpha")).toEqual(info);
    expect(requireRepo("/repos/alpha")).toEqual(info);
    expect(requireRepoRoot("/repos/alpha")).toBe("/repos/alpha");
  });

  it("keeps repos independent so multiple tabs can be open at once", () => {
    registerRepo(info);
    registerRepo({ root: "/repos/beta", branch: "dev", head: "def456" });
    expect(requireRepo("/repos/alpha").branch).toBe("main");
    expect(requireRepo("/repos/beta").branch).toBe("dev");
  });

  it("throws a 409 when the call names an unopened (or missing) repo", () => {
    expect(() => requireRepo("/repos/unknown")).toThrowError(/No repository is open/);
    expect(() => requireRepo("")).toThrow();
    try {
      requireRepo("");
    } catch (e) {
      expect((e as { status?: number }).status).toBe(409);
    }
  });

  it("resolves a root given with surrounding whitespace", () => {
    registerRepo(info);
    expect(requireRepoRoot("  /repos/alpha  ")).toBe("/repos/alpha");
  });
});
