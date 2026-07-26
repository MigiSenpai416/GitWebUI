import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFileSync, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

/**
 * Shutdown behaviour. Separate from the smoke suite because each of these has to
 * quit the app, and that suite shares one instance across its tests.
 *
 * The thing under test is that quitting is immediate. Blocking the quit on a
 * graceful HTTP close meant the window sat there unresponsive for seconds
 * whenever a command was running, because a graceful close waits for the
 * terminal's streaming response to drain.
 */

/** How long a quit may take before it reads as a hang. */
const QUIT_BUDGET_MS = 3000;

/**
 * Kill anything left over from this file's `sleep 417`.
 *
 * Necessary because that command *is* orphaned on Windows (see the note in the
 * second test), and an orphan keeps the stdio pipes it inherited from the app
 * open — which stalls Playwright's worker teardown for a full minute waiting
 * for a process it thinks is still alive.
 */
function reapStrayCommands(): void {
  try {
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
        "Where-Object { $_.CommandLine -like '*sleep.exe*417*' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      { stdio: "ignore" },
    );
  } catch {
    /* nothing to clean up */
  }
}

test.afterAll(() => reapStrayCommands());

/** Command lines of every running process, for spotting orphans. */
function commandLines(): string {
  try {
    return execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
        'Select-Object -ExpandProperty CommandLine"',
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    return "";
  }
}

/** Ask the app to quit and report how long it took to actually exit. */
async function timeQuit(app: ElectronApplication): Promise<number> {
  const proc = app.process();
  let exited = false;
  const closed = new Promise<void>((resolve) => {
    proc.once("exit", () => {
      exited = true;
      resolve();
    });
  });

  const started = Date.now();
  // What File → Quit does.
  await app.evaluate(({ app: a }) => a.quit()).catch(() => {});
  await Promise.race([closed, new Promise((r) => setTimeout(r, 30_000))]);
  const elapsed = Date.now() - started;

  if (!exited) {
    proc.kill();
    throw new Error(`app never exited (waited ${elapsed}ms)`);
  }
  return elapsed;
}

test("quits promptly with nothing running", async () => {
  const started: TestApp = await launchApp();
  const app: ElectronApplication = started.app;
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  // Make sure a keep-alive connection to the API really exists.
  expect(await window.evaluate(async () => (await fetch("/api/auth/status")).status)).toBe(200);

  const elapsed = await timeQuit(app);
  expect(elapsed, `quit took ${elapsed}ms`).toBeLessThan(QUIT_BUDGET_MS);
  await cleanupApp(started);
});

test("quits promptly with a terminal command still running", async () => {
  const repoDir = makeRepo();

  const started: TestApp = await launchApp();
  const app: ElectronApplication = started.app;
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  await window.getByRole("button", { name: "Open" }).first().click();
  await window.locator(".picker-form input").fill(repoDir);
  await window.locator(".picker-form button[type=submit]").click();
  await expect(window.getByText("first commit").first()).toBeVisible();

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("toggle-terminal")?.click();
  });
  await expect(window.locator(".term-dock")).not.toHaveClass(/term-hidden/);
  await window.locator(".term-input").fill("sleep 417");
  await window.locator(".term-input").press("Enter");
  // Let it actually spawn, so the streaming response is genuinely open.
  await new Promise((r) => setTimeout(r, 2000));

  // Our shell, identified by the scratch script it was handed.
  const shellMarker = "gitwebui-term-";
  expect(commandLines(), "the shell should be running before the quit").toContain(shellMarker);

  const elapsed = await timeQuit(app);
  expect(elapsed, `quit took ${elapsed}ms with a command running`).toBeLessThan(QUIT_BUDGET_MS);

  // Quitting quickly and reaping the shell are in tension: an earlier version
  // only reaped it because it happened to sit waiting for the HTTP server to
  // close, so dropping that wait would silently orphan it. Both halves are
  // asserted together so neither can quietly undo the other.
  //
  // Only the shell is checked. A command it started — `sleep` here — is not
  // reaped on Windows, because Git Bash's MSYS layer leaves the grandchild with
  // an unrelated Win32 parent and `taskkill /T` walks the Win32 tree. That is a
  // pre-existing limitation of the terminal's Stop button, not of shutdown, and
  // fixing it needs a Job Object rather than a change here.
  await new Promise((r) => setTimeout(r, 2000));
  expect(commandLines(), "the shell survived the quit").not.toContain(shellMarker);

  await cleanupApp(started);
  await removeRepo(repoDir);
});
