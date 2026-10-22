import { promises as fs } from "node:fs";
import path from "node:path";
import { protocol } from "electron";

/**
 * Where the window's page comes from: a private `gitwebui://app` scheme served
 * straight out of the built UI, with no socket anywhere.
 *
 * A scheme of our own rather than `file://` because it gives the page a real,
 * stable origin of its own — `localStorage`, where the UI keeps the open tabs
 * and the layout, is keyed by origin, and every `file://` page would share
 * one. It is registered as standard and secure so it behaves like https for
 * storage, relative URLs and the secure-context-only APIs.
 */

export const APP_SCHEME = "gitwebui";
export const APP_HOST = "app";
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/`;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // CodeMirror injects a <style> element at runtime (StyleModule) and xterm
  // sets inline styles on every cell; neither can be nonce-threaded, so this
  // one relaxation is unavoidable. Scripts stay locked down, which is what
  // matters for the renderer.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:", // GitHub avatars
  "font-src 'self' data:",
  // Everything the page needs from outside itself goes through IPC.
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/**
 * Must run before the app is ready: privileges can't be granted to a scheme
 * once Chromium has started.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ]);
}

/** Whether `url` is one of this app's own pages. */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/** Every file under `dir`, as routes rooted at "/". */
async function loadAssets(dir: string): Promise<Map<string, Buffer>> {
  const assets = new Map<string, Buffer>();
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const route = "/" + path.relative(dir, full).split(path.sep).join("/");
      assets.set(route, await fs.readFile(full));
    }
  };
  await walk(dir);
  return assets;
}

function respond(body: Buffer | string, status: number, type: string, cache: string): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), {
    status,
    headers: {
      "Content-Type": type,
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": cache,
    },
  });
}

/**
 * Serve the built UI out of memory.
 *
 * Reading it once up front rather than per request keeps Electron's asar shim
 * out of the request path entirely. The whole bundle is a little over a
 * megabyte, so it costs milliseconds at startup.
 */
export async function serveRenderer(dir: string): Promise<void> {
  const assets = await loadAssets(dir);
  const index = assets.get("/index.html");
  if (!index) throw new Error(`${dir} has no index.html`);

  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return respond("Not found", 404, "text/plain", "no-store");

    let route: string;
    try {
      route = decodeURIComponent(url.pathname);
    } catch {
      return respond("Not found", 404, "text/plain", "no-store");
    }
    if (route === "/") route = "/index.html";

    const body = assets.get(route);
    if (body) {
      // Hashed asset names make these immutable; index.html must not be.
      return respond(
        body,
        200,
        MIME[path.extname(route).toLowerCase()] ?? "application/octet-stream",
        route === "/index.html" ? "no-store" : "public, max-age=31536000, immutable",
      );
    }

    // A path that isn't an asset is a client-side route. A path that looks
    // like a file is a genuine miss, and answering it with the SPA shell
    // would turn a broken <script src> into a confusing parse error.
    if (path.extname(route)) return respond("Not found", 404, "text/plain", "no-store");
    return respond(index, 200, "text/html; charset=utf-8", "no-store");
  });
}
