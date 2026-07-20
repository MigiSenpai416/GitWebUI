// Entry point for the Bun single-file executable (`bun build --compile`).
// Unlike index.ts (Node, serves web/dist from disk), this serves the web UI
// from assets embedded in the binary.
import { createApp } from "./app.js";
import { serveEmbedded } from "./embeddedServe.js";
import { resolvePort, resolveHost, wantsHelp, HELP_TEXT } from "./args.js";
import { installProcessGuards } from "./safety.js";

if (wantsHelp()) {
  console.log(HELP_TEXT);
  process.exit(0);
}

installProcessGuards();

let port: number;
let host: string;
try {
  port = resolvePort();
  host = resolveHost();
} catch (e) {
  console.error(`[gitwebui] ${(e as Error).message}`);
  process.exit(1);
}

const app = createApp({ serveStatic: serveEmbedded });

app.listen(port, host, () => {
  const shown = host === "0.0.0.0" ? "localhost" : host;
  console.log(`[gitwebui] server listening on http://${shown}:${port}`);
});
