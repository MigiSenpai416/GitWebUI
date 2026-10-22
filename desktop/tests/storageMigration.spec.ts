import { test, expect, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

/**
 * Upgrading from a release that served the UI from http://127.0.0.1:5175.
 *
 * The open tabs live in localStorage, which is keyed by origin, so they stayed
 * behind when the UI moved to gitwebui://app. The app carries them over once
 * at startup; this plants tabs under the old origin the way 0.3.0 left them,
 * opens a repository in the new build too, and expects both to be there after
 * the carry-over — the old ones first, the new one kept.
 */

const LEGACY_ORIGIN = "http://127.0.0.1:5175";

/** Write localStorage entries under the old origin, the way an old build would have. */
async function plantLegacyStorage(app: ElectronApplication, entries: Record<string, string>): Promise<void> {
  await app.evaluate(async ({ BrowserWindow, session, net }, { origin, entries }) => {
    const { protocol } = session.defaultSession;
    protocol.handle("http", (request) =>
      request.url.startsWith(`${origin}/`)
        ? new Response("<!doctype html><title>legacy</title>", { headers: { "Content-Type": "text/html" } })
        : net.fetch(request, { bypassCustomProtocolHandlers: true }),
    );
    const window = new BrowserWindow({ show: false });
    try {
      await window.loadURL(`${origin}/`);
      await window.webContents.executeJavaScript(
        `for (const [k, v] of Object.entries(${JSON.stringify(entries)})) localStorage.setItem(k, v);`,
      );
    } finally {
      window.destroy();
      protocol.unhandle("http");
    }
  }, { origin: LEGACY_ORIGIN, entries });
}

test("carries the open tabs over from the old origin, once", async () => {
  const oldRepo = makeRepo();
  const newRepo = makeRepo();

  // First launch of the new build: nothing to carry over yet, and a repo is
  // opened in it, as a user might before noticing their tabs are gone.
  let started: TestApp = await launchApp();
  let window = await started.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.getByRole("button", { name: "Open" }).first().click();
  await window.locator(".picker-form input").fill(newRepo);
  await window.locator(".picker-form button[type=submit]").click();
  await expect(window.getByText("first commit").first()).toBeVisible();

  // What the old build left behind, planted while this build is running so
  // the profile is the same one.
  await plantLegacyStorage(started.app, {
    "gwui.tabs": JSON.stringify({
      tabs: [{ id: "legacy1", root: oldRepo, name: path.basename(oldRepo), branch: "main" }],
      activeTabId: "legacy1",
    }),
    "gwui.sidebarCollapsed": "1",
  });
  await started.app.close();
  // The carry-over has already run (and found nothing) on this profile; a
  // user upgrading never had it run, so make it look that way.
  await fs.rm(path.join(started.userDataDir, "storage-migrated"));

  started = await launchApp({ reuse: started });
  window = await started.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  const tabs = window.locator(".tabbar-tabs .tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toContainText(path.basename(oldRepo));
  await expect(tabs.nth(1)).toContainText(path.basename(newRepo));
  await expect(window.locator(".sidebar")).toHaveClass(/collapsed/);
  await expect(fs.readFile(path.join(started.userDataDir, "storage-migrated"), "utf8")).resolves.toMatch(/\d{4}-/);

  // Only once: the old origin is not consulted again.
  await plantLegacyStorage(started.app, {
    "gwui.tabs": JSON.stringify({ tabs: [{ id: "x", root: "C:/nowhere", name: "nowhere", branch: "main" }], activeTabId: "x" }),
  });
  await started.app.close();
  started = await launchApp({ reuse: started });
  window = await started.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".tabbar-tabs .tab")).toHaveCount(2);

  await started.app.close();
  await cleanupApp(started);
  await removeRepo(oldRepo);
  await removeRepo(newRepo);
});
