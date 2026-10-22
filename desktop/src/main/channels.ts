/**
 * The names the preload and the main process agree on. Kept in one file so a
 * rename can't leave one side listening for something nobody sends.
 */
export const CH = {
  /** Synchronous, once, at preload time: platform facts the UI needs up front. */
  bootstrap: "gwui:bootstrap",
  pickDirectory: "gwui:pick-directory",
  openExternal: "gwui:open-external",
  writeClipboard: "gwui:write-clipboard",
  reload: "gwui:reload",
  /** Main → renderer: a menu item or accelerator was activated. */
  menuCommand: "gwui:menu-command",
  /** One call into core/src/api.ts. */
  api: "gwui:api",
  /** Renderer → main: give up on a call still in flight. */
  cancel: "gwui:cancel",
  /** Main → renderer: one line of a running terminal command's output. */
  terminalEvent: "gwui:terminal-event",
} as const;

/** Everything the renderer learns about the machine it is running on. */
export interface Bootstrap {
  platform: NodeJS.Platform;
  pathSep: string;
  homeDir: string;
  appVersion: string;
}

/** Commands the application menu can send to the UI. */
export type MenuCommand =
  | "new-tab"
  | "open-repo"
  | "clone-repo"
  | "create-repo"
  | "close-tab"
  | "toggle-terminal"
  | "refresh";

export interface PickDirectoryOptions {
  title?: string;
  buttonLabel?: string;
  defaultPath?: string;
}

/** A call, as the renderer sends it. */
export interface ApiRequest {
  /** Chosen by the renderer, unique among its calls in flight; names the call to cancel it. */
  id: number;
  route: string;
  input: unknown;
  /** Root of the repository the calling tab has open, or null for none. */
  root: string | null;
}

/**
 * What comes back. The result travels as JSON text rather than as a cloned
 * object, so it reaches the renderer exactly as `JSON.stringify` shapes it —
 * dates as strings, `toJSON` honoured, nothing uncloneable to trip over.
 */
export type ApiReply =
  | { ok: true; json: string }
  | { ok: false; status: number; error: string };
