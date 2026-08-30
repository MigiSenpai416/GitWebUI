import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { cleanupApp, launchApp, type TestApp } from "./helpers";

function makeFastForwardRepo(): string {
  const dir = path.join(os.tmpdir(), `gitwebui-e2e-merge-${randomBytes(6).toString("hex")}`);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  git("config", "user.email", "merge@example.com");
  git("config", "user.name", "Merge Test");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "Merge root");
  git("switch", "-c", "feature");
  git("commit", "--allow-empty", "-m", "Feature work");
  git("switch", "main");
  return dir;
}

async function openRepo(window: Page, repoDir: string): Promise<void> {
  await window.getByRole("button", { name: "Open" }).first().click();
  await window.locator(".picker-form input").fill(repoDir);
  await window.locator(".picker-form button[type=submit]").click();
  await expect(window.getByText("Merge root").first()).toBeVisible();
}

test("branch merge offers and applies an explicit merge commit", async () => {
  const repoDir = makeFastForwardRepo();
  let started: TestApp | undefined;
  let app: ElectronApplication | undefined;

  try {
    started = await launchApp();
    app = started.app;
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await openRepo(window, repoDir);

    await window.getByTitle("Switch branch").click();
    const feature = window.locator(".branch-row").filter({ hasText: "feature" });
    await feature.locator(".bmi-more").click();
    await window.getByRole("button", { name: /Merge into main/ }).click();

    await expect(window.getByRole("button", { name: "Fast-forward if possible" })).toBeVisible();
    await window.getByRole("button", { name: "Create merge commit" }).focus();
    await window.keyboard.press("Enter");
    await expect(window.locator(".toast-notice")).toContainText("Merged feature into main.");

    await expect
      .poll(() => {
        const line = execFileSync(
          "git",
          ["-C", repoDir, "rev-list", "--parents", "-n", "1", "HEAD"],
          { stdio: "pipe" },
        )
          .toString()
          .trim();
        return line.split(" ").length - 1;
      })
      .toBe(2);
    await expect(window.getByText("Merge branch 'feature'").first()).toBeVisible();
  } finally {
    await app?.close().catch(() => {});
    if (started) await cleanupApp(started);
    await fs.rm(repoDir, { recursive: true, force: true });
  }
});
