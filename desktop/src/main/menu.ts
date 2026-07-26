import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { CH, type MenuCommand } from "./channels.js";
import { APP_VERSION } from "./version.js";

/**
 * The application menu.
 *
 * The Edit entries are roles rather than handlers so the OS wires them to
 * whichever control has focus; the rest send intents to the UI, which owns all
 * the state. The menu bar itself is hidden until Alt is pressed — the app draws
 * its own tab strip, so a permanently visible menu bar is redundant chrome —
 * but the accelerators work regardless.
 */

const HOMEPAGE = "https://github.com/MigiSenpai/GitWebUi";

function send(command: MenuCommand): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(CH.menuCommand, command);
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
    {
      label: "&File",
      submenu: [
        item("New Tab", "new-tab", "Ctrl+T"),
        { type: "separator" },
        item("Open Repository…", "open-repo", "Ctrl+O"),
        item("Clone Repository…", "clone-repo", "Ctrl+Shift+O"),
        item("Create Repository…", "create-repo", "Ctrl+Shift+N"),
        { type: "separator" },
        item("Close Tab", "close-tab", "Ctrl+W"),
        { type: "separator" },
        { role: "quit" },
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
        item("Refresh", "refresh", "Ctrl+R"),
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
    {
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

export function installMenu(): void {
  Menu.setApplicationMenu(buildMenu());
}
