import { describe, it, expect } from "vitest";
import { resolvePort, resolveHost, wantsHelp } from "./args.js";

describe("resolvePort", () => {
  it("prefers a CLI flag over env and default", () => {
    expect(resolvePort(["--port", "8080"], { PORT: "3000" })).toBe(8080);
    expect(resolvePort(["--port=8081"], { PORT: "3000" })).toBe(8081);
    expect(resolvePort(["-p", "8082"], {})).toBe(8082);
  });

  it("falls back to env then the default", () => {
    expect(resolvePort([], { PORT: "3000" })).toBe(3000);
    expect(resolvePort([], {})).toBe(5174);
  });

  it("rejects invalid ports", () => {
    expect(() => resolvePort(["--port", "abc"], {})).toThrow(/Invalid port/);
    expect(() => resolvePort(["--port", "0"], {})).toThrow(/Invalid port/);
    expect(() => resolvePort(["--port", "70000"], {})).toThrow(/Invalid port/);
  });
});

describe("resolveHost", () => {
  it("prefers flag, then env, then default", () => {
    expect(resolveHost(["--host", "127.0.0.1"], { HOST: "1.2.3.4" })).toBe("127.0.0.1");
    expect(resolveHost([], { HOST: "1.2.3.4" })).toBe("1.2.3.4");
    expect(resolveHost([], {})).toBe("0.0.0.0");
  });
});

describe("wantsHelp", () => {
  it("detects -h and --help", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["-h"])).toBe(true);
    expect(wantsHelp(["--port", "8080"])).toBe(false);
  });
});
