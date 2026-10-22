import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { callApi, cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

/**
 * One window, shared by every test in the file — launching Electron per test
 * would multiply a ~2s startup across the suite for no extra coverage.
 *
 * The consequence is that these tests are a sequence, not a set: each runs
 * against whatever the ones before it left behind, and the ones after "opens a
 * repository" assume a repository is open. `test.describe.serial` is that
 * contract made explicit — it fixes the order and, when a link fails, skips the
 * rest instead of reporting a cascade of failures that all have one cause.
 *
 * It does not make a single test runnable on its own via `--grep`; nothing can,
 * short of relaunching per test. The preconditions below are asserted with
 * messages that say so, so an isolated run explains itself rather than failing
 * on a confusing selector.
 */
test.describe.serial("desktop app", () => {

let started: TestApp;
let app: ElectronApplication;
let window: Page;
let repoDir = "";

test.beforeAll(async () => {
  repoDir = makeRepo();
  // Set GITWEBUI_E2E_BINARY to run the whole suite against a packaged build
  // instead of the loose bundle. That is the only way to catch the failures
  // that are specific to being packaged — asar path resolution above all.
  started = await launchApp();
  app = started.app;
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

/** Activate an application-menu item by its command id, from the main process. */
async function clickMenuItem(id: string): Promise<void> {
  const clicked = await app.evaluate(({ Menu }, itemId) => {
    const found = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    found?.click();
    return Boolean(found);
  }, id);
  expect(clicked, `no menu item with id "${id}"`).toBe(true);
}

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await cleanupApp(started);
  await removeRepo(repoDir);
});

test("opens a window served from its own app scheme", async () => {
  // Not file:, and not a socket: the scheme is what gives the page an origin
  // of its own, and nothing else may be serving it.
  const url = window.url();
  expect(url).toMatch(/^gitwebui:\/\/app\//);
});

test("opens straight onto the repository picker", async () => {
  await expect(window.getByRole("heading", { name: "Repositories" })).toBeVisible();
});

test("exposes the desktop bridge, and nothing more", async () => {
  const bridge = await window.evaluate(() => {
    const w = window as unknown as { gitwebui?: Record<string, unknown> };
    return {
      present: Boolean(w.gitwebui),
      platform: w.gitwebui?.platform,
      keys: w.gitwebui ? Object.keys(w.gitwebui).sort() : [],
    };
  });
  expect(bridge.present).toBe(true);
  expect(bridge.platform).toBe(process.platform);
  expect(bridge.keys).toEqual([
    "appVersion",
    "call",
    "cancel",
    "homeDir",
    "onMenuCommand",
    "onTerminalEvent",
    "openExternal",
    "pathSep",
    "pickDirectory",
    "platform",
    "reload",
    "writeClipboard",
  ]);
});

test("reaches the core through the bridge", async () => {
  // The renderer's only way to its data. A broken preload, a missing handler
  // or a reply that doesn't survive the trip all show up here first.
  const recent = await callApi<{ recent: unknown }>(window, "recent");
  expect(Array.isArray(recent.recent)).toBe(true);
  await expect(callApi(window, "noSuchRoute")).rejects.toThrow(/\(404\): Unknown operation/);
});

test("keeps Node out of the renderer", async () => {
  const leaked = await window.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    module: typeof (globalThis as Record<string, unknown>).module,
  }));
  expect(leaked).toEqual({ require: "undefined", process: "undefined", module: "undefined" });
});

test("opens a repository and lists its history", async () => {
  // Typed rather than picked: the native chooser can't be driven from here, and
  // the text field is the same code path the picker feeds.
  await window.getByRole("button", { name: "Open" }).first().click();
  const field = window.locator(".picker-form input");
  await field.fill(repoDir);
  await window.locator(".picker-form button[type=submit]").click();

  await expect(window.getByText("first commit").first()).toBeVisible();
});

test("runs a command in the terminal and streams its output", async () => {
  // The terminal is the one call that doesn't answer all at once: its output
  // arrives as events pushed from main while the call is still in flight.
  // Driven through the real menu item rather than its accelerator: injected key
  // events go straight to the renderer and never reach the native menu. This
  // exercises the whole path — menu click, IPC, the renderer's handler, store.
  await clickMenuItem("toggle-terminal");

  // The dock is always mounted and hidden with a class, so waiting on the
  // input alone would pass before it was reachable.
  await expect(window.locator(".term-dock")).not.toHaveClass(/term-hidden/);
  const input = window.locator(".term-input");
  await input.fill("git --version");
  await input.press("Enter");
  await expect(window.locator(".xterm-rows")).toContainText("git version", { timeout: 30_000 });
});

test("refuses to open a second window for an external link", async () => {
  // Left unhandled, window.open gives a chrome-less Electron window carrying
  // this app's preload and pointed at whatever was asked for. A file: URL is
  // used because it exercises the deny path without actually launching the
  // user's browser mid-test.
  const before = app.windows().length;
  await window.evaluate(() => {
    window.open("file:///etc/passwd", "_blank", "noopener");
  });
  await window.waitForTimeout(500);
  expect(app.windows().length).toBe(before);
});

/** Request one of the app's own pages from main, where the scheme is handled. */
async function fetchAppPage(url: string): Promise<{ status: number; csp: string | null }> {
  // Not from the page: its policy has `connect-src 'none'`, so a fetch there
  // would be refused before it reached the handler.
  return await app.evaluate(async ({ net }, target) => {
    const res = await net.fetch(target);
    return { status: res.status, csp: res.headers.get("content-security-policy") };
  }, url);
}

test("serves the UI under a content security policy", async () => {
  // Only meaningful in a packaged/served build — in dev the page comes from
  // Vite, which needs eval and a websocket and so is deliberately exempt.
  const { csp } = await fetchAppPage("gitwebui://app/index.html");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  // Everything the page needs from outside itself goes through the bridge.
  expect(csp).toContain("connect-src 'none'");
  // CodeMirror injects <style> at runtime and xterm sets inline styles, so
  // style-src has to allow inline; script-src must not.
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toMatch(/script-src[^;]*unsafe/);
});

test("answers an unknown asset path with a 404 rather than the app shell", async () => {
  // Serving index.html for a missing .js turns a broken script tag into a
  // confusing syntax error instead of a clear miss.
  const { status } = await fetchAppPage("gitwebui://app/assets/does-not-exist.js");
  expect(status).toBe(404);
});

test("survives a reload", async () => {
  // Main gives up the old page's calls as it navigates away; the new page's
  // must still be answered, and the open repository must come back with it.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  expect(window.url()).toMatch(/^gitwebui:\/\/app\//);
  await expect(
    window.getByText("first commit").first(),
    "the repository from 'opens a repository' did not come back — or that test " +
      "never ran: the suite is serial and cannot be grepped down to a single test.",
  ).toBeVisible();
});

});
