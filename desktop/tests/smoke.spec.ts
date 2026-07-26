import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

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

test("opens a window served from its own loopback API", async () => {
  const url = window.url();
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
});

test("never shows the login screen", async () => {
  // The whole point of desktop mode. If the token or the cookie is wrong this
  // is where it shows up — the store falls back to AuthGate.
  await expect(window.locator(".auth-gate, .authgate")).toHaveCount(0);
  await expect(window.getByRole("heading", { name: "Repositories" })).toBeVisible();
});

test("exposes the desktop bridge, and nothing more", async () => {
  const bridge = await window.evaluate(() => {
    const w = window as unknown as { gitwebui?: Record<string, unknown> };
    return {
      present: Boolean(w.gitwebui),
      isDesktop: w.gitwebui?.isDesktop,
      platform: w.gitwebui?.platform,
      keys: w.gitwebui ? Object.keys(w.gitwebui).sort() : [],
    };
  });
  expect(bridge.present).toBe(true);
  expect(bridge.isDesktop).toBe(true);
  expect(bridge.platform).toBe(process.platform);
  expect(bridge.keys).toEqual([
    "appVersion",
    "homeDir",
    "isDesktop",
    "onMenuCommand",
    "openExternal",
    "pathSep",
    "pickDirectory",
    "platform",
    "reload",
    "writeClipboard",
  ]);
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

test("does not offer a way to sign out of a session it never started", async () => {
  // The Toolbar only exists once a repo is open (web/src/App.tsx), so on the
  // picker screen this assertion would pass whether or not the isDesktop()
  // guard existed. Hence the precondition — and hence its message, which is
  // what an isolated `--grep` run of this test will report.
  await expect(
    window.locator(".toolbar"),
    "no repository is open, so there is no toolbar to check. This test runs " +
      "after 'opens a repository' — the suite is serial and cannot be grepped " +
      "down to a single test.",
  ).toHaveCount(1);
  // A sibling button, as a control — it proves the toolbar really rendered its
  // right-hand group, so a zero count below means the Lock button was omitted
  // rather than the whole group being missing.
  await expect(
    window.getByRole("button", { name: "Search", exact: true }),
    "the toolbar's right-hand group did not render, so a missing Lock button " +
      "would prove nothing",
  ).toHaveCount(1);
  await expect(window.getByRole("button", { name: "Lock", exact: true })).toHaveCount(0);
});

test("runs a command in the terminal and streams its output", async () => {
  // The streaming NDJSON endpoint is the one non-request/response channel in
  // the app, and the reason a loopback server beat a custom protocol.
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

test("serves the UI under a content security policy", async () => {
  // Only meaningful in a packaged/served build — in dev the page comes from
  // Vite, which needs eval and a websocket and so is deliberately exempt.
  const csp = await window.evaluate(async () => {
    const res = await fetch("/index.html");
    return res.headers.get("content-security-policy");
  });
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  // CodeMirror injects <style> at runtime and xterm sets inline styles, so
  // style-src has to allow inline; script-src must not.
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toMatch(/script-src[^;]*unsafe/);
});

test("answers an unknown asset path with a 404 rather than the app shell", async () => {
  // Serving index.html for a missing .js turns a broken script tag into a
  // confusing syntax error instead of a clear miss.
  const status = await window.evaluate(async () => {
    const res = await fetch("/assets/does-not-exist.js");
    return res.status;
  });
  expect(status).toBe(404);
});

test("survives a reload", async () => {
  // Confirms the cookie is a real cookie in the session rather than something
  // that only happened to be present on the first navigation.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".auth-gate, .authgate")).toHaveCount(0);
});

});
