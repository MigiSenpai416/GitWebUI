import { test, expect } from "@playwright/test";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo } from "./helpers";

/**
 * Does the app come back the way it was left?
 *
 * The open repositories live in `localStorage`, which the browser files under
 * the page's origin — and the origin includes the port. When the desktop server
 * took an OS-assigned port, every launch was a new origin and therefore a new,
 * empty storage area: the app opened with no tabs, no sidebar state, no
 * remembered terminal height, while looking for all the world like a fresh
 * install. Hence the fixed port, and hence this test.
 *
 * Both launches share one config dir *and* one Electron profile, which is what
 * makes this a restart rather than two unrelated installs.
 */

test("reopens the repositories that were open when it closed", async () => {
  const repoDir = makeRepo();
  const repoName = path.basename(repoDir);

  // ---- first run: open a repository, then quit ----
  const started = await launchApp();
  const first = started.app;
  const w1 = await first.firstWindow();
  await w1.waitForLoadState("domcontentloaded");
  const firstOrigin = new URL(w1.url()).origin;

  await w1.getByRole("button", { name: "Open" }).first().click();
  await w1.locator(".picker-form input").fill(repoDir);
  await w1.locator(".picker-form button[type=submit]").click();
  await expect(w1.getByText("first commit").first()).toBeVisible();
  await first.close();

  // ---- second run: same profile, same config ----
  const second = (await launchApp({ reuse: started })).app;
  const w2 = await second.firstWindow();
  await w2.waitForLoadState("domcontentloaded");
  const secondOrigin = new URL(w2.url()).origin;

  // The mechanism, asserted directly — a moving origin is what broke this, and
  // it would break it again silently.
  expect(secondOrigin, "the origin must not move between launches").toBe(firstOrigin);

  // The behaviour the user actually sees: the repository is open again, not an
  // empty picker.
  await expect(w2.getByText("first commit").first()).toBeVisible();
  await expect(w2.locator(".tabbar")).toContainText(repoName);
  await expect(w2.getByRole("heading", { name: "Repositories" })).toHaveCount(0);

  await second.close();
  await cleanupApp(started);
  await removeRepo(repoDir);
});
