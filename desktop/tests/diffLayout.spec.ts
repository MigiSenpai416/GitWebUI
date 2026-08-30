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
  let lateFocusLines: string[] = [];
  let earlyFocusLines: string[] = [];

  test.beforeAll(async () => {
    repoDir = makeRepo();
    await fs.writeFile(
      path.join(repoDir, "layout-target.txt"),
      `shared before\nold one ${"x".repeat(420)}\nold two\nshared after\n`,
    );
    await fs.writeFile(path.join(repoDir, "other-target.txt"), "old other\n");
    lateFocusLines = Array.from({ length: 220 }, (_, index) => `late context ${index + 1}`);
    earlyFocusLines = Array.from({ length: 220 }, (_, index) => `early context ${index + 1}`);
    lateFocusLines[179] = "old late change";
    earlyFocusLines[19] = "old early change";
    await fs.writeFile(path.join(repoDir, "focus-late.txt"), `${lateFocusLines.join("\n")}\n`);
    await fs.writeFile(path.join(repoDir, "focus-early.txt"), `${earlyFocusLines.join("\n")}\n`);
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "layout fixture"], { stdio: "pipe" });
    await fs.writeFile(
      path.join(repoDir, "layout-target.txt"),
      `shared before\nnew one ${"y".repeat(12)}\nshared after\n`,
    );
    await fs.writeFile(path.join(repoDir, "other-target.txt"), "new other\n");
    await fs.writeFile(path.join(repoDir, "added-target.txt"), "const added = true;");
    await fs.writeFile(path.join(repoDir, "binary-target.bin"), Buffer.from([0x00, 0x01, 0x02]));
    lateFocusLines[179] = "new late change";
    earlyFocusLines[19] = "new early change";
    await fs.writeFile(path.join(repoDir, "focus-late.txt"), `${lateFocusLines.join("\n")}\n`);
    await fs.writeFile(path.join(repoDir, "focus-early.txt"), `${earlyFocusLines.join("\n")}\n`);

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
    await expect.poll(async () => Math.abs(
      await oldScroller.evaluate((element) => element.scrollWidth - element.clientWidth) -
      await newScroller.evaluate((element) => element.scrollWidth - element.clientWidth),
    )).toBeLessThanOrEqual(1);

    await oldScroller.evaluate((element) => {
      element.scrollLeft = 80;
    });
    await expect.poll(() => newScroller.evaluate((element) => element.scrollLeft)).toBe(80);
    await newScroller.evaluate((element) => {
      element.scrollLeft = 30;
    });
    await expect.poll(() => oldScroller.evaluate((element) => element.scrollLeft)).toBe(30);
    const oldMax = await oldScroller.evaluate((element) => element.scrollWidth - element.clientWidth);
    await oldScroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect.poll(() => oldScroller.evaluate((element) => element.scrollLeft)).toBe(oldMax);
    await expect.poll(() => newScroller.evaluate((element) => element.scrollLeft)).toBe(oldMax);

    const originalSize = await app.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      const size = target.getSize();
      target.setSize(size[0] - 100, size[1]);
      return size;
    });
    await expect.poll(async () => Math.abs(
      await oldScroller.evaluate((element) => element.scrollWidth - element.clientWidth) -
      await newScroller.evaluate((element) => element.scrollWidth - element.clientWidth),
    )).toBeLessThanOrEqual(1);
    await expect.poll(() => oldScroller.evaluate((element) => element.scrollLeft)).toBe(oldMax);
    await expect.poll(() => newScroller.evaluate((element) => element.scrollLeft)).toBe(oldMax);
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]);
    }, originalSize);

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

  test("focuses the first change whenever a different file is selected", async () => {
    const splitButton = window.getByRole("button", { name: "Split layout" });
    const unifiedButton = window.getByRole("button", { name: "Unified layout" });

    await unifiedButton.click();
    await window.locator(".file-row", { hasText: "focus-late.txt" }).click();
    const unifiedScroller = window.locator(".dv-editor-unified .cm-scroller");
    await expect.poll(() => unifiedScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);

    await window.locator(".file-row", { hasText: "focus-early.txt" }).click();
    await expect(window.locator(".dv-editor-unified .cm-content")).toContainText("new early change");
    await expect.poll(() => unifiedScroller.evaluate((element) => element.scrollTop)).toBeLessThan(500);

    await window.locator(".file-row", { hasText: "focus-late.txt" }).click();
    await expect.poll(() => unifiedScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);
    await unifiedScroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await window.locator(".file-row", { hasText: "binary-target.bin" }).click();
    await expect(window.getByText("Binary file — no text diff available.")).toBeVisible();
    await window.locator(".file-row", { hasText: "focus-late.txt" }).click();
    await expect.poll(() => unifiedScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);

    await splitButton.click();
    await window.locator(".file-row", { hasText: "focus-late.txt" }).click();
    const oldScroller = window.locator(".dv-split-old .cm-scroller");
    const newScroller = window.locator(".dv-split-new .cm-scroller");
    await expect.poll(() => oldScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);
    await expect.poll(() => newScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);

    await window.locator(".file-row", { hasText: "focus-early.txt" }).click();
    await expect(window.locator(".dv-split-new .cm-content")).toContainText("new early change");
    await expect.poll(() => oldScroller.evaluate((element) => element.scrollTop)).toBeLessThan(500);
    await expect.poll(() => newScroller.evaluate((element) => element.scrollTop)).toBeLessThan(500);

    await window.locator(".file-row", { hasText: "focus-late.txt" }).click();
    await expect.poll(() => newScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);
    await newScroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await window.locator(".file-row", { hasText: "binary-target.bin" }).click();
    await expect(window.getByText("Binary file — no text diff available.")).toBeVisible();
    await window.locator(".file-row", { hasText: "focus-late.txt" }).click();
    await expect.poll(() => oldScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);
    await expect.poll(() => newScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);
  });

  test("preserves scroll when the selected file refreshes in either layout", async () => {
    const refresh = async () => {
      await window.getByRole("button", { name: "Actions" }).click();
      await window.getByRole("button", { name: "Refresh", exact: true }).click();
    };

    await window.getByRole("button", { name: "Unified layout" }).click();
    await window.locator(".file-row", { hasText: "focus-early.txt" }).click();
    const unifiedScroller = window.locator(".dv-editor-unified .cm-scroller");
    await unifiedScroller.evaluate((element) => {
      element.scrollTop = 900;
    });
    const unifiedTop = await unifiedScroller.evaluate((element) => element.scrollTop);
    earlyFocusLines[59] = "refreshed context 60";
    await fs.writeFile(path.join(repoDir, "focus-early.txt"), `${earlyFocusLines.join("\n")}\n`);
    await refresh();
    await expect(window.locator(".dv-editor-unified .cm-content")).toContainText("refreshed context 60");
    await expect.poll(async () => Math.abs(
      await unifiedScroller.evaluate((element) => element.scrollTop) - unifiedTop,
    )).toBeLessThanOrEqual(1);

    await window.getByRole("button", { name: "Split layout" }).click();
    const oldScroller = window.locator(".dv-split-old .cm-scroller");
    const newScroller = window.locator(".dv-split-new .cm-scroller");
    await newScroller.evaluate((element) => {
      element.scrollTop = 1_400;
    });
    const splitTop = await newScroller.evaluate((element) => element.scrollTop);
    earlyFocusLines[79] = "refreshed context 80";
    await fs.writeFile(path.join(repoDir, "focus-early.txt"), `${earlyFocusLines.join("\n")}\n`);
    await refresh();
    await expect(window.locator(".dv-split-new .cm-content")).toContainText("refreshed context 80");
    await expect.poll(async () => Math.abs(
      await oldScroller.evaluate((element) => element.scrollTop) - splitTop,
    )).toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs(
      await newScroller.evaluate((element) => element.scrollTop) - splitTop,
    )).toBeLessThanOrEqual(1);
  });

  test("keeps the chosen diff layout through File View and new file selections", async () => {
    const splitButton = window.getByRole("button", { name: "Split layout" });
    await window.locator(".file-row", { hasText: "layout-target.txt" }).click();
    await expect(window.locator(".dv-split")).toBeVisible();
    await window.getByRole("button", { name: "File View" }).click();

    await expect(splitButton).toBeDisabled();
    await expect(window.locator(".dv-editor-unified")).toBeVisible();
    await expect(window.locator(".dv-editor-unified .cm-content")).toContainText("new one");
    await expect(window.locator(".dv-editor-unified .cm-content")).not.toContainText("old one");

    await window.getByRole("button", { name: "Diff View" }).click();
    await expect(window.locator(".dv-split")).toBeVisible();

    await window.locator(".file-row", { hasText: "other-target.txt" }).click();
    await expect(window.getByRole("button", { name: "Split layout" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(window.locator(".dv-split")).toBeVisible();
  });

  test("rebuilds editor extensions when File View has the same text as the diff", async () => {
    await window.locator(".file-row", { hasText: "added-target.txt" }).click();
    await expect(window.locator(".dv-split-new .cm-diff-add")).toHaveCount(1);
    await expect(window.locator(".dv-split-old .cm-diff-placeholder")).toHaveCount(1);

    await window.getByRole("button", { name: "File View" }).click();

    await expect(window.locator(".dv-editor-unified .cm-diff-add")).toHaveCount(0);
    await expect(window.locator(".dv-editor-unified .cm-gutter-old")).toHaveCount(0);
    await expect(window.locator(".dv-editor-unified .cm-lineNumbers")).toHaveCount(1);
  });

  test("restores the chosen diff layout after an app restart", async () => {
    await app.close();
    started = await launchApp({ reuse: started });
    app = started.app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await expect(window.getByText("first commit").first()).toBeVisible();
    await window.locator(".file-row", { hasText: "layout-target.txt" }).click();
    await expect(window.getByRole("button", { name: "Split layout" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(window.locator(".dv-split")).toBeVisible();
  });
});
