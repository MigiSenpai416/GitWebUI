import path from "node:path";
import type { Express, Request, Response } from "express";
import { ASSETS } from "./generated/embeddedAssets.js";

// Bun global — this module only runs inside the Bun-compiled binary.
declare const Bun: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } };

const INDEX_ROUTE = "/index.html";

/**
 * Serves the web UI from assets embedded in the Bun executable. Unknown,
 * non-file routes fall back to index.html so the SPA can client-route.
 */
export function serveEmbedded(app: Express): void {
  app.get("*", (req: Request, res: Response, next: (err?: unknown) => void) => {
    void (async () => {
      let route = req.path === "/" ? INDEX_ROUTE : req.path;
      let embedded = ASSETS[route];
      if (!embedded) {
        route = INDEX_ROUTE;
        embedded = ASSETS[INDEX_ROUTE];
      }
      if (!embedded) {
        res.status(404).send("Not found");
        return;
      }
      const buf = Buffer.from(await Bun.file(embedded).arrayBuffer());
      res.type(path.extname(route) || ".html").send(buf);
    })().catch(next);
  });
}
