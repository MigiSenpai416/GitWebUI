import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { cleanupApp, countReplies, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

/**
 * When a call in flight is given up, and when it isn't.
 *
 * The renderer gives a call up by aborting its signal — the terminal's Stop
 * button is the everyday case — and that has to reach the main process and
 * stop the work there, not merely stop the page listening. Calls are also
 * given up when their page goes away: a reload, a crash, the window closing.
 * A navigation that `will-navigate` turns down (a file dropped on the window,
 * a stray link) never takes the page anywhere, so it must leave them alone.
 */

let started: TestApp;
let app: ElectronApplication;
let window: Page;
let repoDir: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  repoDir = makeRepo();
  started = await launchApp();
  app = started.app;
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  await window.getByRole("button", { name: "Open" }).first().click();
  await window.locator(".picker-form input").fill(repoDir);
  await window.locator(".picker-form button[type=submit]").click();
  await expect(window.getByText("first commit").first()).toBeVisible();

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("toggle-terminal")?.click();
  });
  await expect(window.locator(".term-dock")).not.toHaveClass(/term-hidden/);
});

test.afterAll(async () => {
  await app?.close();
  if (started) await cleanupApp(started);
  if (repoDir) await removeRepo(repoDir);
});

test("Stop ends the command in the main process, not just on screen", async () => {
  const replies = await countReplies(app, "terminalRun");
  await window.locator(".term-input").fill("sleep 10 && echo late-$((6*7))");
  await window.locator(".term-input").press("Enter");
  // Let it spawn, so the terminal's call is genuinely in flight.
  await new Promise((r) => setTimeout(r, 1000));
  expect(await replies(), "the command should still be running").toBe(0);

  await window.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(window.locator(".term-dock .xterm-rows")).toContainText("Stopped.");
  // The page prints "Stopped." the moment it gives up; the call settling in
  // main well inside the 10 seconds is what shows the command was killed.
  await expect.poll(replies, { timeout: 5_000 }).toBe(1);
  await expect(window.locator(".term-dock .xterm-rows")).not.toContainText("late-42");
});

// Last: Playwright sees the refused navigation start and never finish, and
// holds page-side locators waiting for it from then on.
test("a refused navigation does not stop a running command", async () => {
  // The marker is computed, so the echoed command line can't satisfy the check.
  await window.locator(".term-input").fill("sleep 3 && echo survived-$((6*7))");
  await window.locator(".term-input").press("Enter");
  // Let it spawn, so the terminal's call is genuinely in flight.
  await new Promise((r) => setTimeout(r, 1000));

  // A refused navigation is handed to the system browser instead; record that
  // rather than actually launching one mid-test.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __opened?: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });

  const before = window.url();
  // What following a stray link (or dropping one on the window) amounts to.
  await window.evaluate(() => {
    location.href = "https://example.invalid/elsewhere";
  });
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []))
    .toEqual(["https://example.invalid/elsewhere"]);

  // Read through main, for the reason above.
  await expect.poll(terminalText, { timeout: 15_000 }).toContain("survived-42");
  expect(await terminalText()).not.toMatch(/survived-42[\s\S]*Stopped\./);
  expect(window.url(), "the navigation should have been refused").toBe(before);
});

async function terminalText(): Promise<string> {
  return await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      "document.querySelector('.term-dock .xterm-rows')?.textContent ?? ''",
    ),
  );
}
