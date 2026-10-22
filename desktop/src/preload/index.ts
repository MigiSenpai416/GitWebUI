import { contextBridge, ipcRenderer } from "electron";
import {
  CH,
  type ApiReply,
  type Bootstrap,
  type MenuCommand,
  type PickDirectoryOptions,
} from "../main/channels.js";
import type { RunEvent } from "../../../core/src/terminal.js";

/**
 * The entire surface the renderer gets: one way to call into the app's core,
 * plus what a page genuinely cannot do on its own — choose a folder, hand a
 * URL to the real browser, write the clipboard, hear the native menu.
 *
 * Runs sandboxed, so this file is bundled to CommonJS — a sandboxed preload
 * cannot be an ES module — and it reads nothing from `process` directly: the
 * facts it needs come from main over a single synchronous call at startup.
 */

const bootstrap = ipcRenderer.sendSync(CH.bootstrap) as Bootstrap;

const api = {
  platform: bootstrap.platform,
  pathSep: bootstrap.pathSep,
  homeDir: bootstrap.homeDir,
  appVersion: bootstrap.appVersion,

  /**
   * Make one call into the core. `id` is the caller's own, unique among its
   * calls in flight, and is what `cancel` takes.
   */
  call: (id: number, route: string, input: unknown, root: string | null): Promise<ApiReply> =>
    ipcRenderer.invoke(CH.api, { id, route, input, root }),

  /** Give up on a call. Its signal is aborted in main; the reply still arrives. */
  cancel: (id: number): void => {
    ipcRenderer.send(CH.cancel, id);
  },

  /** Subscribe to terminal output. Returns an unsubscribe function. */
  onTerminalEvent: (handler: (id: number, event: RunEvent) => void): (() => void) => {
    const listener = (_event: unknown, id: number, event: RunEvent): void => handler(id, event);
    ipcRenderer.on(CH.terminalEvent, listener);
    return () => {
      ipcRenderer.removeListener(CH.terminalEvent, listener);
    };
  },

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
