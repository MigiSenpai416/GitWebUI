import { defineConfig } from "@playwright/test";

/**
 * Electron smoke tests. Deliberately few and load-bearing: they exist to catch
 * the failures that only appear once the app is actually assembled — a preload
 * that doesn't load, a window that opens on the login screen, a renderer that
 * can't reach its own API — not to re-test the UI.
 *
 * Runs against `dist/` and `renderer/`, so `npm run build:desktop` first.
 */
export default defineConfig({
  testDir: "./tests",
  // These share a config directory and a single-instance lock, so they cannot
  // run at the same time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
});
