import os from "node:os";
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { CH, type Bootstrap, type PickDirectoryOptions } from "./channels.js";
import { APP_VERSION } from "./version.js";

/**
 * Handlers for the preload bridge.
 *
 * Every one of these is reachable from renderer code, so each validates its
 * argument rather than trusting it. That is belt-and-braces — the renderer only
 * ever runs our own bundle — but `openExternal` in particular hands a string to
 * the OS, and "the OS will open whatever this says" is not a thing to be
 * relaxed about.
 */

/** Schemes it is safe to hand to the desktop. */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function ownerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

export function registerIpc(): void {
  // Synchronous by design: the preload needs these before any UI code runs, and
  // one blocking call at startup is cheaper than making every consumer async.
  ipcMain.on(CH.bootstrap, (event) => {
    const bootstrap: Bootstrap = {
      platform: process.platform,
      pathSep: process.platform === "win32" ? "\\" : "/",
      homeDir: os.homedir(),
      appVersion: APP_VERSION,
    };
    event.returnValue = bootstrap;
  });

  ipcMain.handle(CH.pickDirectory, async (event, options: PickDirectoryOptions = {}) => {
    const parent = ownerWindow(event);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: typeof options.title === "string" ? options.title : "Choose a folder",
      buttonLabel: typeof options.buttonLabel === "string" ? options.buttonLabel : undefined,
      defaultPath: typeof options.defaultPath === "string" ? options.defaultPath : undefined,
      // createDirectory is macOS-only and harmless elsewhere.
      properties: ["openDirectory", "createDirectory"],
    };
    // Passing the window makes the chooser a sheet on macOS and modal
    // elsewhere, so it can't be lost behind the app.
    const result = parent
      ? await dialog.showOpenDialog(parent, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(CH.openExternal, async (_event, url: unknown) => {
    if (typeof url !== "string") return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    // Without this, a `file:` URL would launch a local program and a custom
    // scheme would reach whatever has registered itself for it.
    if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return;
    await shell.openExternal(parsed.toString());
  });

  // There is deliberately no reveal-in-folder channel here. Revealing is driven
  // by the server (see setOpener in main/index.ts), which already knows which
  // paths belong to the open repository — routing it through the renderer would
  // add a way to open arbitrary paths for no benefit.

  ipcMain.handle(CH.writeClipboard, async (_event, text: unknown) => {
    if (typeof text !== "string") return;
    clipboard.writeText(text);
  });

  ipcMain.on(CH.reload, (event) => {
    // Ignoring the cache matters here: this is the error boundary's escape
    // hatch, and a poisoned bundle in the HTTP cache is one reason to need it.
    event.sender.reloadIgnoringCache();
  });
}
