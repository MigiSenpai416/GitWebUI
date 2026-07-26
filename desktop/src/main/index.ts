import { randomBytes } from "node:crypto";
import path from "node:path";
import { app, BrowserWindow, dialog, session, shell } from "electron";
import { setConfigDir } from "../../../server/src/config.js";
import { setOpener } from "../../../server/src/system.js";
import { killAllCommands, runningCommandCount } from "../../../server/src/terminal.js";
import { beginGitProbe, ensureGitOrPrompt } from "./gitProbe.js";
import { log } from "./log.js";
import { APP_VERSION } from "./version.js";
import { registerIpc } from "./ipc.js";
import { installMenu } from "./menu.js";
import { desktopPort, startServer, type StartedServer } from "./server.js";
import { loadWindowState, trackWindowState, WINDOW_MIN_SIZE } from "./windowState.js";

/**
 * GitWebUI as a desktop app.
 *
 * The frontend is unchanged: it is still a web app talking to the Express API
 * over HTTP. What changes is that both halves live in this process — the API
 * listens on an ephemeral loopback port, and the window is pointed at it. The
 * page really is served from that server, so every relative `/api/…` request
 * the UI already makes resolves correctly with nothing rewritten.
 */

const DEV = process.env.GITWEBUI_DESKTOP_DEV === "1";
/** Where Vite serves the UI in development, per web/vite.config.ts. */
const DEV_RENDERER_ORIGIN = "http://localhost:5173";
/** The port Vite's dev proxy forwards /api to, also per web/vite.config.ts. */
const DEV_API_PORT = 5174;
const BACKGROUND = "#0d1117";

/**
 * The built web UI.
 *
 * Resolved from this file rather than from `app.getAppPath()`, which differs
 * between the two ways this runs: launched as `electron dist/main.js` it is the
 * script's own directory, while packaged it is the asar root. `__dirname` is
 * `<app>/dist` in both cases, so one relative path covers both.
 */
const RENDERER_DIR = path.join(__dirname, "..", "renderer");


/**
 * The secret this window presents to the API. New every launch and never
 * written down: a token that outlived the process it belonged to would be a
 * credential lying around for no reason.
 */
const DESKTOP_TOKEN = randomBytes(32).toString("base64url");

let server: StartedServer | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

// ---------------------------------------------------------------------------
// Where Electron keeps its own state
// ---------------------------------------------------------------------------

/**
 * Chromium's caches, cookies, local storage and this app's window state, kept
 * well away from the git config directory.
 *
 * Both defaults are wrong. Unpackaged, Electron names the directory after the
 * package — `@gitwebui/desktop` — which turns a scope into a stray directory
 * level. Packaged, it would be `%APPDATA%\GitWebUI`, which on a
 * case-insensitive filesystem is the *same directory* as the `%APPDATA%\gitwebui`
 * the server keeps `auth.json` and `github.json` in: Chromium's cache would be
 * emptied on top of the user's credentials, and only on Windows, since
 * elsewhere the two names stay distinct.
 *
 * Set before the single-instance lock is taken, because the lock is keyed on
 * this path.
 *
 * `GITWEBUI_USER_DATA_DIR` overrides it, which is what the end-to-end tests use
 * to get a profile of their own. Without that they share this one with the
 * installed app — and since the port is fixed, they would share its origin too,
 * which means reading and overwriting the developer's real open tabs.
 */
app.setPath(
  "userData",
  process.env.GITWEBUI_USER_DATA_DIR || path.join(app.getPath("appData"), "gitwebui-desktop"),
);

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------

// Two copies would mean two servers and two writers racing on recent.json, and
// the second window would be the one that "didn't work".
if (!app.requestSingleInstanceLock()) {
  log.info("another instance already holds the lock — handing over to it");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void main();
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  installCrashGuards();
  log.info(`starting GitWebUI ${APP_VERSION} (packaged=${app.isPackaged}, dev=${DEV})`);

  // Share the config directory with the headless server rather than using
  // Electron's userData. The password, GitHub token, commit identity and
  // recent repositories are then the same whichever way the app is launched,
  // and there is nothing to migrate for anyone already using it.
  setConfigDir(null);

  // Reveal-in-folder goes through Electron rather than spawning explorer.exe:
  // the desktop app already has a shell integration that handles quoting and
  // odd paths, and it doesn't leave a detached process behind. Registered
  // before the server starts so no request can arrive ahead of it.
  setOpener(async (target: string) => {
    await shell.openPath(target);
  });

  // Not awaited: the search can spend seconds waiting on a login shell, and
  // there is no reason for the window to wait behind it.
  void beginGitProbe();

  await app.whenReady();

  registerIpc();
  installMenu();

  try {
    server = await startServer({
      desktopToken: DESKTOP_TOKEN,
      webDist: DEV ? undefined : RENDERER_DIR,
      port: DEV ? DEV_API_PORT : undefined,
    });
  } catch (error) {
    fatal("Could not start the GitWebUI server", error);
    return;
  }
  log.info(`serving on ${server.origin} (assets from ${DEV ? "vite" : RENDERER_DIR})`);
  if (!DEV && server.port !== desktopPort()) {
    // Worth saying out loud: the port is part of the origin, and the origin is
    // what the open tabs and the rest of the UI's remembered state are filed
    // under. On a different port they are still there, just not reachable —
    // this run will look like a fresh install.
    log.info(
      `port ${desktopPort()} was taken, so this run is on ${server.port}. ` +
        `Open tabs and other saved UI state belong to the usual port and will ` +
        `come back once it is free.`,
    );
  }

  await plantSessionCookie();
  mainWindow = await createWindow();
  log.info("window ready");

  // Asked only once the window exists, so the dialog has something to attach to
  // and the user is looking at the app when it appears.
  void ensureGitOrPrompt(mainWindow);
}

/**
 * Hand the window its credential.
 *
 * The token goes in as an HttpOnly cookie rather than, say, a command-line
 * argument: argv is readable by every process on the machine, whereas a cookie
 * in this session is not, and it rides every request — including the terminal's
 * streaming POST — without the frontend knowing it exists.
 */
async function plantSessionCookie(): Promise<void> {
  if (!server) return;
  // In development the page is served by Vite, so the cookie has to belong to
  // Vite's origin. Chromium treats localhost and 127.0.0.1 as different hosts,
  // and getting this wrong shows up as a login screen inside the desktop app.
  const url = DEV ? DEV_RENDERER_ORIGIN : server.origin;
  await session.defaultSession.cookies.set({
    url,
    name: "gwui_desktop",
    value: DESKTOP_TOKEN,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
}

async function createWindow(): Promise<BrowserWindow> {
  const state = await loadWindowState();

  const window = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: WINDOW_MIN_SIZE.width,
    minHeight: WINDOW_MIN_SIZE.height,
    // The UI is dark-only; without this the window flashes white while the
    // renderer boots.
    backgroundColor: BACKGROUND,
    show: false,
    // The app draws its own tab strip, so a permanently visible menu bar is
    // redundant chrome. Alt still brings it up, and the accelerators work
    // either way.
    autoHideMenuBar: true,
    title: "GitWebUI",
    // The window icon comes from the executable's own resources; Windows needs
    // nothing passed here.
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Nothing in web/src touches Node; CodeMirror and xterm are pure DOM.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
      spellcheck: true,
    },
  });

  if (state.maximized) window.maximize();
  trackWindowState(window);
  hardenNavigation(window);

  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  const target = DEV ? DEV_RENDERER_ORIGIN : (server?.origin ?? "");
  await window.loadURL(target);
  if (DEV) window.webContents.openDevTools({ mode: "detach" });

  return window;
}

/**
 * Keep the window on its own origin.
 *
 * The frontend calls `window.open` to show a created pull request. Left alone
 * that opens a chrome-less Electron window, carrying this app's preload,
 * pointed at github.com — a bad experience and a genuine hole. Navigation is
 * pinned for the same reason: a renderer that wandered off the local origin
 * would still be a privileged one.
 */
function hardenNavigation(window: BrowserWindow): void {
  const allowedOrigin = DEV ? DEV_RENDERER_ORIGIN : (server?.origin ?? "");

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternally(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(allowedOrigin)) return;
    event.preventDefault();
    void openExternally(url);
  });

  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

async function openExternally(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    await shell.openExternal(parsed.toString());
  } catch {
    /* not a URL we can hand to the desktop */
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

// Closing the window closes the app. (On macOS the convention is the opposite,
// which is one of the things that would need revisiting to ship there.)
app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  if (quitting) return;
  quitting = true;
  // A terminal command is a child process of *this* process. Quitting without
  // reaping them leaves them running with nothing reading their output. The
  // kill is issued synchronously and the killer outlives us, so there is
  // nothing to wait for.
  const reaped = runningCommandCount();
  killAllCommands();
  log.info(`shutting down (${reaped} terminal command(s) reaped)`);
  // Deliberately not awaited, and the quit is not deferred. Blocking shutdown
  // on a graceful server close made quitting take seconds whenever a command
  // was running, because a graceful close waits for the terminal's streaming
  // response to drain.
  server?.dispose();
  server = null;
});

// ---------------------------------------------------------------------------
// Crash handling
// ---------------------------------------------------------------------------

/**
 * The server's own `installProcessGuards` is wrong for this process: swallowing
 * an uncaught exception in a CLI leaves a logged message someone may read,
 * while here it leaves a window rendering over a dead backend with no signal at
 * all. Before there is a window to tell, a failure is fatal; afterwards it is
 * reported and the app is left running, because losing unsaved work in the
 * commit box to a background error would be worse than the error.
 */
function installCrashGuards(): void {
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception:", error);
    if (!mainWindow) fatal("GitWebUI hit an unexpected error during startup", error);
  });

  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection:", reason);
  });

  app.on("render-process-gone", (_event, _contents, details) => {
    log.error("renderer gone:", details.reason);
    // A clean exit is the app being closed, not a crash.
    if (details.reason === "clean-exit" || quitting) return;
    dialog.showErrorBox(
      "GitWebUI stopped responding",
      `The window closed unexpectedly (${details.reason}). Reopen the app to carry on.`,
    );
  });

  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    log.error(`child process gone: ${details.type} (${details.reason})`);
  });
}

function fatal(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox(message, detail);
  app.exit(1);
}
