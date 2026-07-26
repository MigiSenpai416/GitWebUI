// Copies the built web UI into desktop/renderer, ready to be packaged.
//
// electron-builder collects files from the app directory it is pointed at, so
// the renderer has to live under desktop/ rather than being referenced across
// the workspace. Copying is also what keeps the desktop bundle honest about
// what it ships: whatever is in desktop/renderer is exactly what the packaged
// app will serve.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "web", "dist");
const to = path.join(root, "desktop", "renderer");

async function main() {
  try {
    await fs.access(path.join(from, "index.html"));
  } catch {
    console.error(`[stage-renderer] ${from} has no index.html — run the web build first.`);
    process.exit(1);
  }

  // Replace rather than merge, so a renamed or deleted asset doesn't linger
  // from a previous build and get shipped.
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });

  const count = (await fs.readdir(to, { recursive: true })).length;
  console.log(`[stage-renderer] staged ${count} entries into ${path.relative(root, to)}`);
}

main().catch((e) => {
  console.error("[stage-renderer]", e);
  process.exit(1);
});
