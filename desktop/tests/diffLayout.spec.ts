import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test.describe.serial("diff viewer layout", () => {
  let started: TestApp;
  let app: ElectronApplication;
  let window: Page;
  let repoDir = "";

  test.beforeAll(async () => {
    repoDir = makeRepo();
    await fs.writeFile(
      path.join(repoDir, "layout-target.txt"),
      `shared before\nold one ${"x".repeat(240)}\nold two\nshared after\n`,
    );
    await fs.writeFile(path.join(repoDir, "other-target.txt"), "old other\n");
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "layout fixture"], { stdio: "pipe" });
    await fs.writeFile(
      path.join(repoDir, "layout-target.txt"),
      `shared before\nnew one ${"y".repeat(240)}\nshared after\n`,
    );
    await fs.writeFile(path.join(repoDir, "other-target.txt"), "new other\n");
    await fs.writeFile(path.join(repoDir, "added-target.txt"), "const added = true;");

    started = await launchApp();
    app = started.app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByRole("button", { name: "Open" }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.getByText("first commit").first()).toBeVisible();
    await window.locator(".file-row", { hasText: "layout-target.txt" }).click();
    await expect(window.locator(".diff-viewer")).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    await cleanupApp(started);
    await removeRepo(repoDir);
  });

  test("defaults to unified and splits deletions from additions on demand", async () => {
    const unifiedButton = window.getByRole("button", { name: "Unified layout" });
    const splitButton = window.getByRole("button", { name: "Split layout" });

    await expect(unifiedButton).toHaveAttribute("aria-pressed", "true");
    await expect(splitButton).toHaveAttribute("aria-pressed", "false");
    await expect(window.locator(".dv-editor-unified")).toBeVisible();
    await expect(window.locator(".dv-editor-unified .cm-content")).toContainText("old one");
    await expect(window.locator(".dv-editor-unified .cm-content")).toContainText("new one");

    await splitButton.click();

    await expect(splitButton).toHaveAttribute("aria-pressed", "true");
    await expect(window.locator(".dv-split")).toBeVisible();
    await expect(window.locator(".dv-split-old .cm-content")).toContainText("old one");
    await expect(window.locator(".dv-split-old .cm-content")).not.toContainText("new one");
    await expect(window.locator(".dv-split-new .cm-content")).toContainText("new one");
    await expect(window.locator(".dv-split-new .cm-content")).not.toContainText("old one");
    await expect(window.locator(".dv-split-old .cm-diff-del")).toHaveCount(2);
    await expect(window.locator(".dv-split-old .cm-diff-add")).toHaveCount(0);
    await expect(window.locator(".dv-split-new .cm-diff-add")).toHaveCount(1);
    await expect(window.locator(".dv-split-new .cm-diff-del")).toHaveCount(0);
    await expect(window.locator(".dv-split-new .cm-diff-placeholder")).toHaveCount(1);
    await expect(window.locator(".dv-split-old .cm-gutter-old")).toHaveCount(1);
    await expect(window.locator(".dv-split-new .cm-gutter-new")).toHaveCount(1);
    await expect(window.getByRole("region", { name: "Original file" })).toBeVisible();
    await expect(window.getByRole("region", { name: "Modified file" })).toBeVisible();
    await expect(window.getByRole("textbox", { name: "Original file" })).toBeVisible();
    await expect(window.getByRole("textbox", { name: "Modified file" })).toBeVisible();

    const oldScroller = window.locator(".dv-split-old .cm-scroller");
    const newScroller = window.locator(".dv-split-new .cm-scroller");
    expect(await oldScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await newScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await oldScroller.evaluate((element) => element.clientHeight)).toBe(
      await newScroller.evaluate((element) => element.clientHeight),
    );

    await oldScroller.evaluate((element) => {
      element.scrollLeft = 80;
    });
    await expect.poll(() => newScroller.evaluate((element) => element.scrollLeft)).toBe(80);
    await newScroller.evaluate((element) => {
      element.scrollLeft = 30;
    });
    await expect.poll(() => oldScroller.evaluate((element) => element.scrollLeft)).toBe(30);

    await window.locator(".dv-split-old .cm-content").click();
    await window.keyboard.press("Control+f");
    const findInput = window.getByRole("textbox", { name: "Find in file" });
    await expect(findInput).toBeFocused();
    await findInput.press("Escape");
    await expect(window.locator(".dv-split-old .cm-content")).toBeFocused();

    await window.keyboard.press("Control+f");
    await expect(findInput).toBeFocused();
    await window.getByRole("button", { name: "Unified layout" }).click();
    await expect(window.locator(".dv-editor-unified")).toBeVisible();
    await findInput.press("Escape");
    await expect(window.locator(".dv-editor-unified .cm-content")).toBeFocused();
    await window.getByRole("button", { name: "Split layout" }).click();
    await expect(window.locator(".dv-split")).toBeVisible();
  });

  test("keeps both layout controls usable at the supported narrow window size", async () => {
    const originalSize = await app.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      const size = target.getSize();
      target.setSize(900, 560);
      return size;
    });

    const layoutToggle = window.locator(".dv-layout-toggle");
    const toggleBox = await layoutToggle.boundingBox();
    const headerBox = await window.locator(".dv-header").boundingBox();
    const closeBox = await window.locator(".dv-close").boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    expect(toggleBox!.width).toBeGreaterThanOrEqual(49);
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width);
    await expect(window.getByRole("button", { name: "Unified layout" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Split layout" })).toBeVisible();

    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]);
    }, originalSize);
  });

  test("keeps the chosen diff layout through File View and resets it for the next file", async () => {
    const splitButton = window.getByRole("button", { name: "Split layout" });
    await window.getByRole("button", { name: "File View" }).click();

    await expect(splitButton).toBeDisabled();
    await expect(window.locator(".dv-editor-unified")).toBeVisible();
    await expect(window.locator(".dv-editor-unified .cm-content")).toContainText("new one");
    await expect(window.locator(".dv-editor-unified .cm-content")).not.toContainText("old one");

    await window.getByRole("button", { name: "Diff View" }).click();
    await expect(window.locator(".dv-split")).toBeVisible();

    await window.locator(".file-row", { hasText: "other-target.txt" }).click();
    await expect(window.getByRole("button", { name: "Unified layout" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(window.locator(".dv-editor-unified")).toBeVisible();
  });

  test("rebuilds editor extensions when File View has the same text as the diff", async () => {
    await window.locator(".file-row", { hasText: "added-target.txt" }).click();
    await expect(window.locator(".dv-editor-unified .cm-diff-add")).toHaveCount(1);
    await expect(window.locator(".dv-editor-unified .cm-gutter-old")).toHaveCount(1);

    await window.getByRole("button", { name: "File View" }).click();

    await expect(window.locator(".dv-editor-unified .cm-diff-add")).toHaveCount(0);
    await expect(window.locator(".dv-editor-unified .cm-gutter-old")).toHaveCount(0);
    await expect(window.locator(".dv-editor-unified .cm-lineNumbers")).toHaveCount(1);
  });
});
