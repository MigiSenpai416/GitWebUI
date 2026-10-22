/**
 * The bridge the preload exposes as `window.gitwebui`.
 *
 * The UI only ever runs inside the app's own window, so the bridge is always
 * there. The helpers below are the one place that reaches for it, which keeps
 * the components free of `window.gitwebui` and lets tests mock this module.
 */

export type DesktopPlatform = "win32" | "darwin" | "linux" | (string & {});

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

/** What a call into the core comes back as. */
export type ApiReply =
  | { ok: true; json: string }
  | { ok: false; status: number; error: string };

/** One line of a running terminal command's output. */
export interface RunEvent {
  t: "out" | "err" | "exit";
  d?: string;
  code?: number | null;
  cwd?: string;
  killed?: boolean;
}

export interface DesktopBridge {
  platform: DesktopPlatform;
  pathSep: string;
  homeDir: string;
  appVersion: string;
  call(id: number, route: string, input: unknown, root: string | null): Promise<ApiReply>;
  cancel(id: number): void;
  onTerminalEvent(handler: (id: number, event: RunEvent) => void): () => void;
  pickDirectory(options?: PickDirectoryOptions): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  reload(): void;
  onMenuCommand(handler: (command: MenuCommand) => void): () => void;
}

declare global {
  interface Window {
    gitwebui?: DesktopBridge;
  }
}

/** The bridge. Throws if the page is not running inside the app's window. */
export function desktop(): DesktopBridge {
  const bridge = typeof window !== "undefined" ? window.gitwebui : undefined;
  if (!bridge) throw new Error("GitWebUI must be run as the desktop app");
  return bridge;
}

/** An example absolute path for this machine, for empty-field placeholders. */
export function examplePath(...segments: string[]): string {
  const bridge = desktop();
  return [bridge.homeDir, ...segments].join(bridge.pathSep);
}

/** Open a URL in the user's browser rather than in an app window. */
export function openExternal(url: string): void {
  void desktop().openExternal(url);
}

/**
 * Copy text through the bridge. `navigator.clipboard` would work too, but it is
 * permission-gated and the bridge never is.
 */
export async function writeClipboard(text: string): Promise<void> {
  await desktop().writeClipboard(text);
}

/** Reload the app, bypassing any cached bundle. */
export function reload(): void {
  desktop().reload();
}

/** Ask for a folder with the OS chooser. Resolves to null when the user cancels. */
export async function pickDirectory(options?: PickDirectoryOptions): Promise<string | null> {
  return desktop().pickDirectory(options);
}
