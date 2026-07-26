import { promises as fs } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express, Request, Response } from "express";
import { createApp } from "../../../server/src/app.js";
import { LOOPBACK_HOSTS } from "../../../server/src/originGuard.js";

/**
 * The API the desktop window talks to: the same Express app the headless server
 * and the standalone binary run, listening on an ephemeral loopback port.
 *
 * Port 0 lets the OS pick a free one, so two copies of the app — or a headless
 * server already sitting on 5174 — can never collide. The window is pointed at
 * whatever port comes back, which is also why the frontend's relative `/api/…`
 * URLs keep working untouched: the page really is served from this server.
 */

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
  "connect-src 'self'",
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

/**
 * Serve the built UI out of memory.
 *
 * `express.static` would work, but everything it does well — stat, realpath,
 * range requests, conditional GETs — it does against Electron's asar shim
 * rather than a real filesystem, which is a category of bug with nothing to
 * gain. The whole bundle is a little over a megabyte, so reading it once at
 * startup costs milliseconds and removes asar from the picture entirely.
 */
function serveFromMemory(assets: Map<string, Buffer>): (app: Express) => void {
  const index = assets.get("/index.html");

  return (app: Express) => {
    // NOTE: Express 4 wildcard. On Express 5 this must become "/*splat".
    app.get("*", (req: Request, res: Response) => {
      const route = req.path === "/" ? "/index.html" : req.path;
      const body = assets.get(route);
      res.setHeader("Content-Security-Policy", CSP);
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (body) {
        res.type(MIME[path.extname(route).toLowerCase()] ?? "application/octet-stream");
        // Hashed asset names make these immutable; index.html must not be.
        res.setHeader(
          "Cache-Control",
          route === "/index.html" ? "no-store" : "public, max-age=31536000, immutable",
        );
        res.send(body);
        return;
      }

      // A path that isn't an asset is a client-side route. A path that looks
      // like a file is a genuine miss, and answering it with the SPA shell
      // would turn a broken <script src> into a confusing parse error.
      if (!index || path.extname(route)) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      res.type("text/html; charset=utf-8").setHeader("Cache-Control", "no-store");
      res.send(index);
    });
  };
}

export interface StartedServer {
  port: number;
  origin: string;
  /**
   * Stop listening and drop whatever is in flight. Synchronous and immediate by
   * design: this runs while the user is waiting for the app to close.
   */
  dispose: () => void;
}

export interface StartServerOptions {
  /** Directory holding the built web UI. Omitted in dev, where Vite serves it. */
  webDist?: string;
  /** The secret the window presents as a cookie. */
  desktopToken: string;
  /**
   * Port to listen on. Defaults to `desktopPort()`, falling back to an
   * OS-assigned one if that is taken.
   */
  port?: number;
}

/**
 * The port the desktop app prefers.
 *
 * It matters that this is stable rather than ephemeral. The window is served
 * from `http://127.0.0.1:<port>`, and the browser keys `localStorage` by
 * origin — which includes the port — so a new port every launch means a new,
 * empty storage area every launch. That is where the UI keeps the open tabs,
 * the sidebar state, the visible refs and the terminal height, all of which
 * silently reset when the port moves.
 *
 * 5175 sits next to the headless server's 5174 without colliding with it, and
 * is below the ephemeral range the OS hands out for outbound connections, so
 * nothing else is likely to be squatting on it.
 *
 * A predictable port is not a security concession: any local process can scan
 * the loopback range in milliseconds, so the port was never the thing keeping
 * anyone out. The desktop session cookie and the Host allowlist are.
 */
export const DEFAULT_DESKTOP_PORT = 5175;

/**
 * The port to try first. `GITWEBUI_DESKTOP_PORT` overrides it — the end-to-end
 * tests set it so they neither collide with an installed copy already holding
 * 5175 nor, by being pushed onto a fallback port, lose the stable origin the
 * persistence test exists to check.
 */
export function desktopPort(): number {
  const raw = process.env.GITWEBUI_DESKTOP_PORT;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) return parsed;
  }
  return DEFAULT_DESKTOP_PORT;
}

function listenOn(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const started = app.listen(port, "127.0.0.1");
    // Attached before the listening event so a bind failure rejects rather than
    // escaping as an uncaught exception.
    started.once("error", reject);
    started.once("listening", () => {
      started.removeListener("error", reject);
      resolve(started);
    });
  });
}

export async function startServer(options: StartServerOptions): Promise<StartedServer> {
  let serveStatic: ((app: Express) => void) | undefined;
  if (options.webDist) {
    serveStatic = serveFromMemory(await loadAssets(options.webDist));
  }

  const app = createApp({
    serveStatic,
    desktopToken: options.desktopToken,
    // This server answers to exactly one loopback port and nothing else, which
    // is what makes a Host allowlist possible here and not in headless mode.
    allowedHosts: LOOPBACK_HOSTS,
  });

  const wanted = options.port ?? desktopPort();
  let server: Server;
  try {
    server = await listenOn(app, wanted);
  } catch (error) {
    // Something else already has the port. Rather than refuse to start, take
    // whatever the OS offers — the app works, and the only casualty is the
    // remembered UI state, which belongs to the other origin anyway.
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    server = await listenOn(app, 0);
  }

  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    dispose: () => {
      // Destroy sockets rather than waiting for them. A graceful close() waits
      // for every in-flight response to finish, and this app has one that is
      // deliberately long-lived — the terminal's streaming NDJSON reply — so
      // waiting meant the window sat there for seconds after the user asked to
      // quit. Nothing is lost by dropping them: the process is on its way out,
      // and the listening socket is the OS's to reclaim either way.
      server.closeAllConnections();
      server.close();
    },
  };
}
