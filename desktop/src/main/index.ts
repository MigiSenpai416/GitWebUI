import path from "node:path";
import { app, BrowserWindow, dialog, nativeTheme, shell } from "electron";
import { setConfigDir } from "../../../core/src/config.js";
import { settleTokenWork } from "../../../core/src/github.js";
import { setOpener } from "../../../core/src/system.js";
import { killAllCommands, runningCommandCount } from "../../../core/src/terminal.js";
import { abortAllCalls, registerApi } from "./api.js";
import { beginGitProbe, ensureGitOrPrompt } from "./gitProbe.js";
import { log } from "./log.js";
import { APP_VERSION } from "./version.js";
import { registerIpc } from "./ipc.js";
import { installMenu } from "./menu.js";
import { APP_URL, isAppUrl, registerAppScheme, serveRenderer } from "./protocol.js";
import { adoptLoginShellPath } from "./shellPath.js";
import { migrateLegacyStorage } from "./storageMigration.js";
import { loadWindowState, trackWindowState, WINDOW_MIN_SIZE } from "./windowState.js";

/**
 * GitWebUI.
 *
 * Two halves in one app. The main process owns everything that touches the
 * machine — git, the GitHub and AI APIs, the terminal, the config directory —
 * through core/src/api.ts. The window is the React UI, sandboxed, served from
 * the private `gitwebui://app` scheme, and it reaches the core only through
 * the preload's IPC bridge. Nothing listens on a port.
 */

const DEV = process.env.GITWEBUI_DESKTOP_DEV === "1";
/** Where Vite serves the UI in development, per web/vite.config.ts. */
const DEV_RENDERER_ORIGIN = "http://localhost:5173";
const BACKGROUND = "#0d1117";
/** The most a quit waits for a GitHub token refresh in flight to reach disk. */
const TOKEN_SETTLE_TIMEOUT_MS = 3_000;

/**
 * The built web UI.
 *
 * Resolved from this file rather than from `app.getAppPath()`, which differs
 * between the two ways this runs: launched as `electron dist/main.js` it is the
 * script's own directory, while packaged it is the asar root. `__dirname` is
 * `<app>/dist` in both cases, so one relative path covers both.
 */
const RENDERER_DIR = path.join(__dirname, "..", "renderer");

let mainWindow: BrowserWindow | null = null;
/** The window being created, so a second request for one joins it. */
let windowPending: Promise<BrowserWindow> | null = null;
/** Set once the interface is being served, which is what a window needs. */
let started = false;
let quitting = false;
let tokenWorkSettled = false;

// ---------------------------------------------------------------------------
// Where Electron keeps its own state
// ---------------------------------------------------------------------------

/**
 * Chromium's caches, local storage and this app's window state, kept well away
 * from the git config directory.
 *
 * Both defaults are wrong. Unpackaged, Electron names the directory after the
 * package — `@gitwebui/desktop` — which turns a scope into a stray directory
 * level. Packaged, it would be `%APPDATA%\GitWebUI`, which on a
 * case-insensitive filesystem is the *same directory* as the `%APPDATA%\gitwebui`
 * the core keeps `github.json` and the other credentials in: Chromium's cache
 * would be emptied on top of the user's credentials, and only on Windows, since
 * elsewhere the two names stay distinct.
 *
 * Set before the single-instance lock is taken, because the lock is keyed on
 * this path.
 *
 * `GITWEBUI_USER_DATA_DIR` overrides it, which is what the end-to-end tests use
 * to get a profile of their own. Without that they share this one with the
 * installed app, which means reading and overwriting the developer's real open
 * tabs.
 */
app.setPath(
  "userData",
  process.env.GITWEBUI_USER_DATA_DIR || path.join(app.getPath("appData"), "gitwebui-desktop"),
);

// Privileges can only be granted to a scheme before the app is ready.
registerAppScheme();

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------

// Two copies would mean two writers racing on recent.json and the GitHub
// credentials, and the second window would be the one that "didn't work".
if (!app.requestSingleInstanceLock()) {
  log.info("another instance already holds the lock — handing over to it");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      // Only macOS gets here without a window (the app lives on in the Dock
      // after its window closes); the relaunch is the user asking for one.
      if (started && !quitting) void ensureWindow();
      return;
    }
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

  // Keep the config directory earlier releases used rather than Electron's
  // userData, so the GitHub token, commit identity, AI settings and recent
  // repositories carry over with nothing to migrate.
  setConfigDir(null);

  // Reveal-in-folder goes through Electron rather than spawning explorer.exe:
  // the desktop app already has a shell integration that handles quoting and
  // odd paths, and it doesn't leave a detached process behind. Registered
  // before the API is, so no call can arrive ahead of it.
  setOpener(async (target: string) => {
    await shell.openPath(target);
  });

  // macOS only; a no-op elsewhere. Before the git probe, which is the first
  // thing to go looking down the PATH.
  await adoptLoginShellPath();

  // Not awaited: the search can spend seconds, and there is no reason for the
  // window to wait behind it.
  void beginGitProbe();

  await app.whenReady();

  // The UI is dark-only. On macOS the title bar and the native dialogs follow
  // the system appearance, so on a light-mode Mac they would sit pale above a
  // dark window; pinning the theme keeps the chrome matching the content.
  if (process.platform === "darwin") nativeTheme.themeSource = "dark";

  registerIpc();
  registerApi();
  installMenu(() => void ensureWindow());

  if (!DEV) {
    try {
      await serveRenderer(RENDERER_DIR);
    } catch (error) {
      fatal("Could not load the GitWebUI interface", error);
      return;
    }
  }
  log.info(`interface from ${DEV ? DEV_RENDERER_ORIGIN : RENDERER_DIR}`);
  started = true;

  let window: BrowserWindow;
  try {
    window = await ensureWindow();
  } catch (error) {
    fatal("Could not open the GitWebUI window", error);
    return;
  }
  log.info("window ready");

  // Asked only once the window exists, so the dialog has something to attach to
  // and the user is looking at the app when it appears.
  void ensureGitOrPrompt(window);
}

/**
 * The main window, creating it if there isn't one.
 *
 * Creation is asynchronous, so a second request that lands while the first is
 * still loading — the Dock icon clicked twice, a relaunch during startup —
 * joins it rather than opening another window over the same remembered tabs.
 */
function ensureWindow(): Promise<BrowserWindow> {
  if (mainWindow) return Promise.resolve(mainWindow);
  if (!windowPending) {
    windowPending = createWindow()
      .then((window) => {
        mainWindow = window;
        return window;
      })
      .finally(() => {
        windowPending = null;
      });
  }
  return windowPending;
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
    // Windows uses the executable's resources and macOS the bundle's; Linux
    // needs an explicit icon.
    icon: process.platform === "linux" ? path.join(__dirname, "..", "build", "icon.png") : undefined,
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

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  // Once, the first time this build opens over an older profile: the UI reads
  // its remembered state as it starts, so this has to come first.
  if (!DEV) await migrateLegacyStorage(window.webContents);
  await window.loadURL(DEV ? DEV_RENDERER_ORIGIN : APP_URL);
  // Shown once the UI has loaded rather than on first paint, which could be
  // one of the carry-over's blank pages.
  window.show();
  if (DEV) window.webContents.openDevTools({ mode: "detach" });

  return window;
}

/**
 * Keep the window on its own pages.
 *
 * The frontend calls `window.open` to show a created pull request. Left alone
 * that opens a chrome-less Electron window, carrying this app's preload,
 * pointed at github.com — a bad experience and a genuine hole. Navigation is
 * pinned for the same reason: a renderer that wandered off the app's own pages
 * would still be a privileged one.
 */
function hardenNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternally(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isOwnPage(url)) return;
    event.preventDefault();
    void openExternally(url);
  });

  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function isOwnPage(url: string): boolean {
  if (!DEV) return isAppUrl(url);
  try {
    return new URL(url).origin === DEV_RENDERER_ORIGIN;
  } catch {
    return false;
  }
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

// Closing the window closes the app — except on macOS, where an app stays in
// the Dock without a window and opens a fresh one when it is activated again.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (started && !quitting) void ensureWindow();
});

app.on("before-quit", (event) => {
  if (quitting) {
    // A second quit (Ctrl+Q again, the close button) must not cut the hold short.
    if (!tokenWorkSettled) event.preventDefault();
    return;
  }
  quitting = true;
  // A terminal command is a child process of *this* process. Quitting without
  // reaping them leaves them running with nothing reading their output. The
  // kill is issued synchronously and the killer outlives us, so there is
  // nothing to wait for.
  const reaped = runningCommandCount();
  killAllCommands();
  log.info(`shutting down (${reaped} terminal command(s) reaped)`);
  // Whatever else is in flight — a log walk, a search, an AI request — has
  // nobody left to answer. Aborting stops the git processes behind them.
  abortAllCalls();
  // The one thing worth deferring the quit for: a GitHub token refresh in
  // flight. GitHub retires the old refresh token the moment it answers, so
  // quitting before the new pair reaches disk leaves the stored credentials
  // dead and the account "expired" on the next launch. settleTokenWork() stops
  // further refreshes from starting, so only work already under way is waited for.
  event.preventDefault();
  void Promise.race([
    settleTokenWork().then((waited) => {
      if (waited) log.info("held the quit for a GitHub token refresh to finish");
    }),
    new Promise<void>((resolve) => setTimeout(resolve, TOKEN_SETTLE_TIMEOUT_MS)),
  ]).finally(() => {
    tokenWorkSettled = true;
    app.quit();
  });
});

// ---------------------------------------------------------------------------
// Crash handling
// ---------------------------------------------------------------------------

/**
 * An uncaught exception here must not be swallowed silently: it would leave a
 * window rendering over a dead core with no signal at all. During startup a
 * failure is fatal; once the app is up it is reported and the app is left
 * running, because losing unsaved work in the commit box to a background error
 * would be worse than the error. (Not keyed on there being a window: on macOS
 * the app runs on without one.)
 */
function installCrashGuards(): void {
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception:", error);
    if (!started) fatal("GitWebUI hit an unexpected error during startup", error);
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
