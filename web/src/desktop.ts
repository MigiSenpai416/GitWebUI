/**
 * The desktop bridge, when there is one.
 *
 * The app is the same web app whether it is running in a browser or inside the
 * Electron window, so every one of these is optional and every caller needs a
 * path for "there is no bridge". The helpers below exist so that fallback is
 * written once rather than at each call site.
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

export interface DesktopBridge {
  isDesktop: true;
  platform: DesktopPlatform;
  pathSep: string;
  homeDir: string;
  appVersion: string;
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

/** The bridge, or null in a browser. */
export function desktop(): DesktopBridge | null {
  return typeof window !== "undefined" && window.gitwebui ? window.gitwebui : null;
}

export function isDesktop(): boolean {
  return desktop() !== null;
}

/**
 * Which OS the *server* is on. In the desktop app that is this machine; in a
 * browser the only clue available is the browser's own platform, which is the
 * client and may not be the same machine at all. It is used for cosmetic
 * things — an example path in a placeholder — so a wrong guess is survivable.
 */
export function hostPlatform(): DesktopPlatform {
  const bridge = desktop();
  if (bridge) return bridge.platform;
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Win")
    ? "win32"
    : "linux";
}

export function isWindowsHost(): boolean {
  return hostPlatform() === "win32";
}

/** An example absolute path for the host OS, for empty-field placeholders. */
export function examplePath(...segments: string[]): string {
  const bridge = desktop();
  if (isWindowsHost()) {
    const home = bridge?.homeDir ?? "C:\\Users\\you";
    return [home, ...segments].join("\\");
  }
  const home = bridge?.homeDir ?? "/home/you";
  return [home, ...segments].join("/");
}

/**
 * Open a URL outside the app. In the desktop app `window.open` would be
 * intercepted anyway, but going through the bridge keeps the intent explicit.
 */
export function openExternal(url: string): void {
  const bridge = desktop();
  if (bridge) {
    void bridge.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/**
 * Copy text, preferring the bridge. `navigator.clipboard` does work in the
 * desktop app — http://127.0.0.1 counts as a secure context — but it is
 * permission-gated and the bridge never is.
 */
export async function writeClipboard(text: string): Promise<void> {
  const bridge = desktop();
  if (bridge) {
    await bridge.writeClipboard(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

/** Reload the app, bypassing any cached bundle. */
export function reload(): void {
  const bridge = desktop();
  if (bridge) {
    bridge.reload();
    return;
  }
  window.location.reload();
}

/**
 * Ask for a folder with the OS chooser. Returns null when there is no bridge,
 * which callers read as "carry on with the text field".
 */
export async function pickDirectory(options?: PickDirectoryOptions): Promise<string | null> {
  const bridge = desktop();
  if (!bridge) return null;
  return bridge.pickDirectory(options);
}
