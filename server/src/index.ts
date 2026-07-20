import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import express, { type Express } from "express";
import { createApp } from "./app.js";
import { resolvePort, resolveHost, wantsHelp, HELP_TEXT } from "./args.js";
import { installProcessGuards } from "./safety.js";

if (wantsHelp()) {
  console.log(HELP_TEXT);
  process.exit(0);
}

installProcessGuards();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let port: number;
let host: string;
try {
  port = resolvePort();
  host = resolveHost();
} catch (e) {
  console.error(`[gitwebui] ${(e as Error).message}`);
  process.exit(1);
}

// In production the built web app (web/dist) is served from disk with an SPA fallback.
function serveStaticFromDisk(app: Express): void {
  const webDist = path.resolve(__dirname, "../../web/dist");
  if (!existsSync(webDist)) return;
  app.use(express.static(webDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const app = createApp({ serveStatic: serveStaticFromDisk });

app.listen(port, host, () => {
  const shown = host === "0.0.0.0" ? "localhost" : host;
  console.log(`[gitwebui] server listening on http://${shown}:${port}`);
});
