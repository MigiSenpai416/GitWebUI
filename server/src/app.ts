import express, { type Express } from "express";
import { api, apiErrorHandler } from "./routes.js";
import { authRouter, requireAuth, setDesktopToken } from "./auth.js";
import { originGuard } from "./originGuard.js";

export interface AppOptions {
  /**
   * Mounts static-asset serving for the built web UI (SPA). Called last, after
   * the API. The Node entry serves from disk; the Bun binary serves embedded
   * assets; the desktop app serves them from memory. When omitted (dev), Vite
   * serves the frontend instead.
   */
  serveStatic?: (app: Express) => void;
  /**
   * Turns this into a private server for one client that already holds the
   * token — the desktop app's own window. The password gate is replaced
   * wholesale rather than merely bypassed: setting a password and signing in
   * are refused, so a local browser that finds the port can't claim an install
   * whose owner never set one. Leave unset for the shared, password-gated
   * server.
   */
  desktopToken?: string;
  /**
   * Host names this server answers to. Set it when the answer is knowable — a
   * desktop app serving one loopback port — to shut out DNS rebinding. The
   * headless server leaves it unset because it is reached by LAN address or
   * through a reverse proxy under a name it can't predict.
   */
  allowedHosts?: string[];
}

/**
 * Builds the Express app shared by every entry point. The web UI is public so
 * the login screen can load; all `/api/*` data routes sit behind `requireAuth`.
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();

  // No CORS: the UI and the API are always the same origin — Vite proxies /api
  // in dev, and one server hosts both in production. Allowing cross-origin
  // requests only granted any page the user visits a readable channel to the
  // login endpoint, which is a password oracle against a machine-local port.
  //
  // The guard is the other half of that: not sending CORS headers stops a page
  // reading the response, and this stops the request being made at all.
  app.use(originGuard({ allowedHosts: options.allowedHosts }));

  app.use(express.json({ limit: "2mb" }));

  if (options.desktopToken !== undefined) setDesktopToken(options.desktopToken);

  // Public auth endpoints must be reachable without a session.
  app.use("/api/auth", authRouter);
  // Everything else under /api requires a valid session cookie.
  app.use("/api", requireAuth);
  app.use("/api", api);
  app.use("/api", apiErrorHandler);

  options.serveStatic?.(app);

  return app;
}
