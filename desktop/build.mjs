// Builds the Electron main process and preload with esbuild.
//
// Both are emitted as CommonJS. Electron's main process only supports ESM from
// v28 with awkward sequencing rules, and a sandboxed preload cannot be ESM at
// all — bundling to CJS sidesteps both, and incidentally converts the server's
// ESM sources on the way through.
//
//   node build.mjs            one-shot build
//   node build.mjs --watch    rebuild on change, and restart Electron each time

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const require = createRequire(import.meta.url);

// Baked in rather than read from `app.getVersion()`: unpackaged, Electron does
// not treat desktop/ as the app root and reports its own version instead of
// ours, so a dev run would claim to be GitWebUI 43.2.0.
const appVersion = require("./package.json").version;

/**
 * Restarts Electron whenever either bundle is rebuilt.
 *
 * Both the main process and the preload need this: a preload is read once when
 * the window is created, so rebuilding it without restarting leaves the running
 * app on the old one and makes the edit look like it did nothing.
 *
 * One restarter is shared between the two builds and the restart is debounced,
 * so the initial build — which finishes both at nearly the same moment — starts
 * a single Electron rather than racing two.
 */
function createRestarter() {
  let child = null;
  let timer = null;

  const stop = () => {
    if (!child) return;
    const dying = child;
    child = null;
    // Detach first: this exit is us replacing it, not the user quitting.
    dying.removeAllListeners("exit");
    dying.kill();
  };

  const start = () => {
    timer = null;
    stop();
    child = spawn(require("electron"), [path.join(here, "dist", "main.js")], {
      stdio: "inherit",
      env: { ...process.env, GITWEBUI_DESKTOP_DEV: "1" },
    });
    // Quitting the app should end the watch, not silently orphan it.
    child.on("exit", () => process.exit(0));
  };

  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });

  return {
    plugin: (name) => ({
      name: `restart-electron-${name}`,
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(start, 120);
        });
      },
    }),
  };
}

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  // Electron is provided by the runtime, never bundled.
  external: ["electron"],
  define: {
    "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
};

const restarter = watch ? createRestarter() : null;

const main = {
  ...shared,
  entryPoints: [path.join(here, "src", "main", "index.ts")],
  outfile: path.join(here, "dist", "main.js"),
  plugins: restarter ? [restarter.plugin("main")] : [],
};

const preload = {
  ...shared,
  entryPoints: [path.join(here, "src", "preload", "index.ts")],
  outfile: path.join(here, "dist", "preload.js"),
  plugins: restarter ? [restarter.plugin("preload")] : [],
};

if (watch) {
  // Preload first, so the very first Electron launch already has one to load.
  // Built without the plugin so this doesn't schedule a launch of its own.
  await esbuild.build({ ...preload, plugins: [] });
  const preloadCtx = await esbuild.context(preload);
  const mainCtx = await esbuild.context(main);
  await preloadCtx.watch();
  await mainCtx.watch();
  console.log("[desktop] watching — edit main/ or preload/ to rebuild and restart");
} else {
  await Promise.all([esbuild.build(preload), esbuild.build(main)]);
}
