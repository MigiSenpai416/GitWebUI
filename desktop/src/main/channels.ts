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
