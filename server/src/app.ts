import express, { type Express } from "express";
import { api, apiErrorHandler } from "./routes.js";
import { authRouter, requireAuth } from "./auth.js";

export interface AppOptions {
  /**
   * Mounts static-asset serving for the built web UI (SPA). Called last, after
   * the API. The Node entry serves from disk; the Bun binary serves embedded
   * assets. When omitted (dev), Vite serves the frontend instead.
   */
  serveStatic?: (app: Express) => void;
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
  app.use(express.json({ limit: "2mb" }));

  // Public auth endpoints must be reachable without a session.
  app.use("/api/auth", authRouter);
  // Everything else under /api requires a valid session cookie.
  app.use("/api", requireAuth);
  app.use("/api", api);
  app.use("/api", apiErrorHandler);

  options.serveStatic?.(app);

  return app;
}
