import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test.describe("Git blame", () => {
  let started: TestApp;
  let app: ElectronApplication;
  let window: Page;
  let repoDir = "";

  test.beforeAll(async () => {
    repoDir = makeRepo();
    await fs.writeFile(path.join(repoDir, "guide.txt"), "first author\nshared line\n");
    execFileSync("git", ["-C", repoDir, "add", "guide.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "Add guide"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Second Author"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "second@example.com"], { stdio: "pipe" });
    await fs.writeFile(path.join(repoDir, "guide.txt"), "first author\nshared line\nsecond author\n");
    execFileSync("git", ["-C", repoDir, "add", "guide.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "Expand guide"], { stdio: "pipe" });
    await fs.writeFile(path.join(repoDir, "guide.txt"), "first author\nlocal edit\nsecond author\n");

    started = await launchApp();
    app = started.app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.getByRole("button", { name: "Open" }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.getByText("Expand guide").first()).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    await cleanupApp(started);
    await removeRepo(repoDir);
  });

  test("chooses a file and explains committed and working-tree lines", async () => {
    await window.getByRole("button", { name: "Blame", exact: true }).click();
    const dialog = window.getByRole("dialog", { name: "Blame a File" });
    await expect(dialog).toBeVisible();
    const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBe(0);
    expect(dialogBox!.y).toBe(0);
    expect(dialogBox!.width).toBe(viewport.width);
    expect(dialogBox!.height).toBe(viewport.height);
    await expect(dialog.getByRole("button", { name: "Blame selected" })).toBeDisabled();

    const file = dialog.locator('.fm-row[title="guide.txt"]');
    await file.locator(".fm-row-main").click();
    await expect(dialog.getByRole("button", { name: "Blame selected" })).toBeEnabled();
    await file.locator(".fm-row-main").dblclick();

    const blame = dialog.getByRole("region", { name: "Git blame for guide.txt" });
    await expect(blame).toBeVisible();
    await expect(blame.locator(".blame-summary")).toContainText("3 lines");
    await expect(blame.locator(".blame-summary")).toContainText("2 commits");
    await expect(blame.locator(".blame-summary")).toContainText("2 authors");
    await expect(blame.locator(".blame-summary")).toContainText("1 uncommitted");
    await expect(blame.locator(".cm-content")).toContainText("first author");
    await expect(blame.locator(".cm-blame-marker.labelled")).toHaveCount(3);
    await expect(blame.locator(".cm-line")).toHaveCount(3);
    await expect(blame.getByRole("button", { name: "Refresh blame" })).toBeVisible();

    await blame.locator(".cm-content").focus();
    await window.keyboard.press("ArrowDown");
    await expect(blame.locator(".blame-detail-heading")).toContainText("Line 2");

    await blame.locator(".cm-line").nth(1).click();
    await expect(blame.locator(".blame-detail-heading")).toContainText("Uncommitted change");
    await expect(blame.locator(".blame-explanation")).toContainText("differs from HEAD");

    await blame.locator(".cm-line").first().click();
    await expect(blame.locator(".blame-detail-heading")).toContainText("Add guide");
    await expect(blame.locator(".blame-meta")).toContainText("End To End");
    await expect(blame.locator(".blame-meta")).toContainText("guide.txt:1");

    const originalSize = await app.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      const size = target.getSize();
      target.setSize(900, 560);
      return size;
    });
    const narrowDialogBox = await dialog.boundingBox();
    const detailsBox = await blame.locator(".blame-details").boundingBox();
    expect(narrowDialogBox).not.toBeNull();
    expect(detailsBox).not.toBeNull();
    expect(detailsBox!.x + detailsBox!.width).toBeLessThanOrEqual(narrowDialogBox!.x + narrowDialogBox!.width);
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]);
    }, originalSize);

    await window.keyboard.press("Escape");
    await expect(blame).toBeHidden();
    await expect(file.locator(".fm-row-main")).toBeFocused();
  });
});
