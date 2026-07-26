/**
 * The application's version, substituted by esbuild from desktop/package.json.
 *
 * `app.getVersion()` is not usable for this: unpackaged, Electron does not
 * treat `desktop/` as the app root and returns Electron's own version, so the
 * Help menu and the log would both claim the app is version 43.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-dev";
