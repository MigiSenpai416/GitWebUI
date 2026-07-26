import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Rejects requests that reached this server from somewhere it doesn't serve.
 *
 * Two different attacks, two different checks:
 *
 * **Cross-origin requests.** A page on the public web can't read a response
 * from a machine-local server (no CORS headers are sent, so the browser
 * withholds it), but the request still *happens*, and a request that changes
 * something doesn't need to be readable to be a problem. A browser labels
 * those with an `Origin` naming the page that sent them, so an `Origin` whose
 * host isn't the host being addressed is refused. Requests with no `Origin` at
 * all — curl, a same-origin GET — are left alone; this is not an
 * authentication check and the password gate still stands behind it.
 *
 * Hosts are compared without their port. Comparing ports too would reject the
 * dev setup, where Vite serves the UI on one port and proxies the API to
 * another, and would buy only protection from a different app on the same
 * machine — which is a far weaker threat than the one being addressed.
 *
 * **DNS rebinding.** An attacker's domain re-resolves to 127.0.0.1, which makes
 * their page genuinely same-origin and defeats every `Origin` check by
 * definition. What it cannot fake is the `Host` header — it still says
 * `evil.com`. So a caller that knows exactly which hosts it answers to (the
 * desktop app, which serves one loopback port and nothing else) can pass
 * `allowedHosts` and have everything else refused.
 *
 * The headless server deliberately leaves `allowedHosts` unset: it binds all
 * interfaces by design, and is reached by LAN address or through a
 * TLS-terminating reverse proxy under a name it can't know in advance.
 * `GITWEBUI_ALLOWED_HOSTS` is there for operators who do know.
 */

export interface OriginGuardOptions {
  /**
   * Host names (with or without a port) this server answers to. When set,
   * anything else is refused. When unset, any `Host` is accepted and only the
   * cross-origin check applies.
   */
  allowedHosts?: string[];
}

/**
 * The host part of a `Host` header value, without its port.
 *
 * Parsed by pinning it to a URL rather than by hand, because the value has to
 * end up in the same form as `originHostname()` produces and the two must not
 * be able to drift. Hand-stripping the brackets off an IPv6 literal looks
 * equivalent and isn't: `URL.hostname` keeps them — they are structural, since
 * without them a colon in the address is indistinguishable from the port
 * separator — so `[::1]` and `::1` compared unequal and a page was refused
 * access to its own origin.
 *
 * A malformed authority (`:5174`, an empty value) fails to parse and is
 * reported as no host at all, which callers treat as untrusted.
 */
function hostname(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // A bare IPv6 address is not a legal URL authority — it has to be bracketed —
  // but it is the obvious thing to write in GITWEBUI_ALLOWED_HOSTS, so accept it.
  const authority =
    !trimmed.startsWith("[") && trimmed.split(":").length > 2 ? `[${trimmed}]` : trimmed;
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The host an `Origin` header points at, or null if it isn't a usable URL. */
function originHostname(value: string): string | null {
  // "null" is what a sandboxed iframe or a file:// page sends. It can never
  // match a host, and treating it as absent would be the wrong way round.
  if (value === "null") return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseAllowedHosts(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * Build the guard. `allowedHosts` entries may include a port; it is ignored,
 * matching the host-only comparison used everywhere else here.
 */
export function originGuard(options: OriginGuardOptions = {}): RequestHandler {
  const allowed = options.allowedHosts ?? parseAllowedHosts(process.env.GITWEBUI_ALLOWED_HOSTS);
  const allowedNames = allowed
    ?.map((h) => hostname(h))
    .filter((h): h is string => h !== null);

  return function guard(req: Request, res: Response, next: NextFunction): void {
    const hostHeader = req.headers.host;
    const host = typeof hostHeader === "string" ? hostname(hostHeader) : null;

    if (allowedNames) {
      if (!host || !allowedNames.includes(host)) {
        res.status(403).json({ error: "Request addressed to an unrecognised host" });
        return;
      }
    }

    const originHeader = req.headers.origin;
    if (typeof originHeader === "string" && originHeader !== "") {
      const origin = originHostname(originHeader);
      // Without a Host to compare against there is nothing to authorise the
      // origin, so an explicit allowlist is the only thing that can.
      const target = host ?? null;
      const ok = origin !== null && target !== null && origin === target;
      if (!ok) {
        res.status(403).json({ error: "Cross-origin request refused" });
        return;
      }
    }

    next();
  };
}

/**
 * The loopback names a server bound to 127.0.0.1 legitimately answers to.
 * `::1` covers the IPv6 loopback in either spelling — `hostname()` brackets a
 * bare address, so this and `[::1]` normalise to the same thing.
 */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
