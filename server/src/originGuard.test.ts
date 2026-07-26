import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { originGuard, LOOPBACK_HOSTS } from "./originGuard.js";

interface Outcome {
  passed: boolean;
  status: number | null;
  body: unknown;
}

/** Drive the middleware with just the headers it looks at. */
function run(
  headers: Record<string, string>,
  options: Parameters<typeof originGuard>[0] = {},
): Outcome {
  const outcome: Outcome = { passed: false, status: null, body: null };
  const res = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    json(body: unknown) {
      outcome.body = body;
      return this;
    },
  } as unknown as Response;

  originGuard(options)({ headers } as unknown as Request, res, () => {
    outcome.passed = true;
  });
  return outcome;
}

describe("cross-origin requests", () => {
  it("lets through a request with no Origin at all", () => {
    // curl, a same-origin GET, the standalone binary being scripted. This is
    // not authentication; the password gate is still behind it.
    expect(run({ host: "127.0.0.1:5174" }).passed).toBe(true);
  });

  it("lets through an Origin that matches the host being addressed", () => {
    expect(
      run({ host: "127.0.0.1:5174", origin: "http://127.0.0.1:5174" }).passed,
    ).toBe(true);
  });

  it("refuses an Origin from somewhere else", () => {
    const out = run({ host: "127.0.0.1:5174", origin: "https://evil.example" });
    expect(out.passed).toBe(false);
    expect(out.status).toBe(403);
  });

  it("ignores the port, so the dev proxy's two ports are one origin", () => {
    // Vite serves the UI on 5173 and proxies /api to 5174. Requiring the ports
    // to match would reject every request in development.
    expect(
      run({ host: "localhost:5174", origin: "http://localhost:5173" }).passed,
    ).toBe(true);
  });

  it("accepts a reverse proxy's hostname on both headers", () => {
    // Behind TLS termination the browser sends https:// and the proxy forwards
    // its own Host; the schemes differ and the hosts agree.
    expect(
      run({ host: "git.example.com", origin: "https://git.example.com" }).passed,
    ).toBe(true);
  });

  it("refuses an opaque Origin", () => {
    // What a sandboxed iframe or a file:// page sends. It can never match a
    // host, so treating it as absent would be exactly the wrong way round.
    const out = run({ host: "127.0.0.1:5174", origin: "null" });
    expect(out.passed).toBe(false);
    expect(out.status).toBe(403);
  });

  it("refuses an Origin that isn't a URL", () => {
    expect(run({ host: "127.0.0.1:5174", origin: "not a url" }).passed).toBe(false);
  });

  it("compares hosts case-insensitively", () => {
    expect(
      run({ host: "Git.Example.com", origin: "https://git.example.COM" }).passed,
    ).toBe(true);
  });

  it("lets a page reach its own origin over an IPv6 literal", () => {
    // The two headers are parsed by different routes — one is a bare authority,
    // the other a whole URL — and an IPv6 address is where they most easily
    // disagree, because the brackets are part of the parsed host in a URL but
    // look strippable in a Host header. Getting this wrong refuses a page
    // access to itself: the UI loads (same-origin GETs carry no Origin) and
    // then every POST is rejected.
    expect(run({ host: "[::1]:5174", origin: "http://[::1]:5174" }).passed).toBe(true);
  });

  it("still refuses a different host over IPv6", () => {
    expect(run({ host: "[::1]:5174", origin: "http://[2001:db8::1]:5174" }).passed).toBe(false);
  });
});

describe("host allowlist", () => {
  const desktop = { allowedHosts: LOOPBACK_HOSTS };

  it("admits the loopback names a local server answers to", () => {
    for (const host of ["127.0.0.1:5174", "localhost:5174", "[::1]:5174"]) {
      expect(run({ host }, desktop).passed).toBe(true);
    }
  });

  it("accepts an IPv6 allowlist entry written either way", () => {
    // `::1` is what a person writes; `[::1]` is what a URL requires. Both have
    // to mean the same thing, or an entry silently does nothing.
    for (const allowed of [["::1"], ["[::1]"]]) {
      expect(run({ host: "[::1]:5174" }, { allowedHosts: allowed }).passed).toBe(true);
    }
  });

  it("refuses a rebound name pointing at the loopback address", () => {
    // The whole point: DNS rebinding makes the attacker's page same-origin, so
    // Origin agrees with Host and every origin check passes. Host is the one
    // thing that still says evil.example.
    const out = run(
      { host: "evil.example:5174", origin: "http://evil.example:5174" },
      desktop,
    );
    expect(out.passed).toBe(false);
    expect(out.status).toBe(403);
  });

  it("refuses a request with no Host header", () => {
    expect(run({}, desktop).passed).toBe(false);
  });

  it("ignores a port given in the allowlist", () => {
    expect(run({ host: "127.0.0.1:9999" }, { allowedHosts: ["127.0.0.1:5174"] }).passed).toBe(true);
  });

  it("accepts any host when no allowlist is given", () => {
    // The headless server binds every interface on purpose and is reached by
    // LAN address or a proxy name it cannot know in advance.
    expect(run({ host: "192.168.1.20:5174" }).passed).toBe(true);
    expect(run({ host: "git.example.com" }).passed).toBe(true);
  });
});

describe("the allowlist can come from the environment", () => {
  it("reads GITWEBUI_ALLOWED_HOSTS when no list is passed", () => {
    vi.stubEnv("GITWEBUI_ALLOWED_HOSTS", "git.example.com, 127.0.0.1");
    try {
      expect(run({ host: "git.example.com" }).passed).toBe(true);
      expect(run({ host: "127.0.0.1:5174" }).passed).toBe(true);
      expect(run({ host: "elsewhere.example" }).passed).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("treats an empty variable as no allowlist", () => {
    vi.stubEnv("GITWEBUI_ALLOWED_HOSTS", "  ");
    try {
      expect(run({ host: "anything.example" }).passed).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
