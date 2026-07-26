import { contextBridge, ipcRenderer } from "electron";
import {
  CH,
  type Bootstrap,
  type MenuCommand,
  type PickDirectoryOptions,
} from "../main/channels.js";

/**
 * The entire surface the renderer gets. Everything privileged already goes
 * through the local HTTP API, so this covers only what a web page genuinely
 * cannot do: choose a folder, hand a URL to the real browser, reveal a path in
 * the file manager.
 *
 * Runs sandboxed, so this file is bundled to CommonJS — a sandboxed preload
 * cannot be an ES module — and it reads nothing from `process` directly: the
 * facts it needs come from main over a single synchronous call at startup.
 */

const bootstrap = ipcRenderer.sendSync(CH.bootstrap) as Bootstrap;

const api = {
  isDesktop: true as const,
  platform: bootstrap.platform,
  pathSep: bootstrap.pathSep,
  homeDir: bootstrap.homeDir,
  appVersion: bootstrap.appVersion,

  /** Native folder chooser. Resolves to null when the user cancels. */
  pickDirectory: (options?: PickDirectoryOptions): Promise<string | null> =>
    ipcRenderer.invoke(CH.pickDirectory, options ?? {}),

  /** Open a URL in the user's browser rather than in an Electron window. */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CH.openExternal, url),

  writeClipboard: (text: string): Promise<void> => ipcRenderer.invoke(CH.writeClipboard, text),

  /** Hard reload, used by the error boundary's recovery button. */
  reload: (): void => {
    ipcRenderer.send(CH.reload);
  },

  /** Subscribe to menu activations. Returns an unsubscribe function. */
  onMenuCommand: (handler: (command: MenuCommand) => void): (() => void) => {
    // The IpcRendererEvent is deliberately not forwarded: it carries `sender`,
    // which would hand the renderer a way back into the IPC layer.
    const listener = (_event: unknown, command: MenuCommand): void => handler(command);
    ipcRenderer.on(CH.menuCommand, listener);
    return () => {
      ipcRenderer.removeListener(CH.menuCommand, listener);
    };
  },
};

contextBridge.exposeInMainWorld("gitwebui", api);

export type GitWebUIBridge = typeof api;
