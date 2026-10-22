import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { CH, type MenuCommand } from "./channels.js";
import { APP_VERSION } from "./version.js";

/**
 * The application menu.
 *
 * The Edit entries are roles rather than handlers so the OS wires them to
 * whichever control has focus; the rest send intents to the UI, which owns all
 * the state. On Windows and Linux the menu bar is hidden until Alt is pressed —
 * the app draws its own tab strip, so a permanently visible menu bar is
 * redundant chrome — but the accelerators work regardless. On macOS the bar
 * lives at the top of the screen as always, led by the application menu.
 */

const HOMEPAGE = "https://github.com/MigiSenpai/GitWebUi";
const MAC = process.platform === "darwin";

let openWindow: () => void = () => {};

function send(command: MenuCommand): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!window) {
    // On macOS the menu is there with no window open. A command then means
    // "bring the app back" first; the command itself is dropped, as there is
    // no UI yet to carry it out.
    openWindow();
    return;
  }
  window.webContents.send(CH.menuCommand, command);
}

/**
 * A menu entry that forwards an intent to the UI. The id is the command name,
 * which makes every one of these addressable via
 * `Menu.getApplicationMenu().getMenuItemById(...)` — how the end-to-end tests
 * exercise this path, since injected key events bypass native accelerators.
 */
const item = (
  label: string,
  command: MenuCommand,
  accelerator?: string,
): MenuItemConstructorOptions => ({
  id: command,
  label,
  accelerator,
  click: () => send(command),
});

export function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    // macOS puts About and Quit in the application menu; the File menu below
    // only carries Quit where there is no such menu.
    ...(MAC ? [{ role: "appMenu" as const }] : []),
    {
      label: "&File",
      submenu: [
        item("New Tab", "new-tab", "CmdOrCtrl+T"),
        { type: "separator" },
        item("Open Repository…", "open-repo", "CmdOrCtrl+O"),
        item("Clone Repository…", "clone-repo", "CmdOrCtrl+Shift+O"),
        item("Create Repository…", "create-repo", "CmdOrCtrl+Shift+N"),
        { type: "separator" },
        item("Close Tab", "close-tab", "CmdOrCtrl+W"),
        ...(MAC ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    {
      // Roles, not custom handlers: the OS wires these to the focused control.
      label: "&Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "&View",
      submenu: [
        item("Refresh", "refresh", "CmdOrCtrl+R"),
        // Ctrl rather than Cmd on macOS too: Cmd+` is the system's own
        // "next window" shortcut there.
        item("Toggle Terminal", "toggle-terminal", "Ctrl+`"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    MAC
      ? {
          // Cmd+W is Close Tab, so closing the window gets a shortcut of its own.
          role: "window",
          submenu: [
            { role: "minimize" },
            { role: "zoom" },
            { role: "close", accelerator: "CmdOrCtrl+Shift+W" },
            { type: "separator" },
            { role: "front" },
          ],
        }
      : {
          label: "&Window",
          submenu: [{ role: "minimize" }, { role: "zoom" }],
        },
    {
      label: "&Help",
      submenu: [
        {
          label: `About GitWebUI ${APP_VERSION}`,
          click: () => void shell.openExternal(HOMEPAGE),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/** `onNoWindow` is what a command does when there is no window to send it to. */
export function installMenu(onNoWindow: () => void): void {
  openWindow = onNoWindow;
  Menu.setApplicationMenu(buildMenu());
}
