import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test.describe.serial("diff viewer search", () => {
  let started: TestApp;
  let app: ElectronApplication;
  let window: Page;
  let repoDir = "";

  test.beforeAll(async () => {
    repoDir = makeRepo();
    await fs.writeFile(path.join(repoDir, "mode-target.txt"), "shared\nold-only-token\n");
    execFileSync("git", ["-C", repoDir, "add", "mode-target.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "search fixture"], { stdio: "pipe" });
    await fs.writeFile(path.join(repoDir, "mode-target.txt"), "shared\nnew-only-token\n");

    const prefix = Array.from({ length: 120 }, (_, index) => `plain line ${index + 1}`).join("\n");
    await fs.writeFile(
      path.join(repoDir, "search-target.txt"),
      `${prefix}\nfirst needle\nsecond NEEDLE\nthird needle\n`,
    );
    await fs.writeFile(
      path.join(repoDir, "binary-target.bin"),
      Buffer.from([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]),
    );
    await fs.writeFile(path.join(repoDir, "large-target.txt"), `${"hit ".repeat(10_000)}\n`);

    started = await launchApp();
    app = started.app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByRole("button", { name: "Open" }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.getByText("first commit").first()).toBeVisible();

    await window.locator(".file-row", { hasText: "search-target.txt" }).click();
    await expect(window.locator(".diff-viewer")).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    await cleanupApp(started);
    await removeRepo(repoDir);
  });

  test("opens with Ctrl+F, highlights all hits, and navigates in both directions", async () => {
    await window.keyboard.press("Control+f");
    const input = window.getByRole("textbox", { name: "Find in file" });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    await window.setViewportSize({ width: 900, height: 560 });
    await input.fill("needle");
    await expect(window.locator(".dv-find-count")).toHaveText("1 of 3");
    await expect(window.locator(".cm-file-search-match")).toHaveCount(3);
    await expect(window.locator(".cm-file-search-match").nth(0)).toHaveClass(
      /cm-file-search-match-active/,
    );
    expect(await window.locator(".cm-scroller").evaluate((scroller) => scroller.scrollTop)).toBeGreaterThan(0);

    const bodyBox = await window.locator(".dv-body").boundingBox();
    const findBox = await window.locator(".dv-find").boundingBox();
    expect(bodyBox).not.toBeNull();
    expect(findBox).not.toBeNull();
    expect(findBox!.x).toBeGreaterThanOrEqual(bodyBox!.x);
    expect(findBox!.x + findBox!.width).toBeLessThanOrEqual(bodyBox!.x + bodyBox!.width);
    expect(findBox!.y + findBox!.height).toBeLessThanOrEqual(bodyBox!.y);

    await window.getByRole("button", { name: "Next match" }).click();
    await expect(input).toBeFocused();
    await expect(window.locator(".dv-find-count")).toHaveText("2 of 3");
    await expect(window.locator(".cm-file-search-match").nth(1)).toHaveClass(
      /cm-file-search-match-active/,
    );

    await window.getByRole("button", { name: "Previous match" }).click();
    await expect(input).toBeFocused();
    await expect(window.locator(".dv-find-count")).toHaveText("1 of 3");

    await input.press("Shift+Enter");
    await expect(window.locator(".dv-find-count")).toHaveText("3 of 3");
    await expect(window.locator(".cm-file-search-match").nth(2)).toHaveClass(
      /cm-file-search-match-active/,
    );
    await window.setViewportSize({ width: 1280, height: 720 });
  });

  test("reapplies the open search when switching between Diff and File View", async () => {
    await window.locator(".file-row", { hasText: "mode-target.txt" }).click();
    await window.keyboard.press("Control+f");
    const input = window.getByRole("textbox", { name: "Find in file" });

    await input.fill("old-only-token");
    await expect(window.locator(".dv-find-count")).toHaveText("1 of 1");
    await window.getByRole("button", { name: "File View" }).click();
    await expect(window.locator(".dv-find-count")).toHaveText("No results");

    await input.fill("new-only-token");
    await expect(window.locator(".dv-find-count")).toHaveText("1 of 1");
    await window.getByRole("button", { name: "Diff View" }).click();
    await expect(window.locator(".dv-find-count")).toHaveText("1 of 1");

    await input.press("Escape");
    await expect(window.locator(".cm-file-search-match")).toHaveCount(0);
    await window.keyboard.press("Escape");
  });

  test("reports misses and closes search before closing the file", async () => {
    await window.locator(".file-row", { hasText: "search-target.txt" }).click();
    await window.keyboard.press("Control+f");
    const input = window.getByRole("textbox", { name: "Find in file" });
    await input.fill("not present");
    await expect(window.locator(".dv-find-count")).toHaveText("No results");
    await expect(window.getByRole("button", { name: "Previous match" })).toBeDisabled();
    await expect(window.getByRole("button", { name: "Next match" })).toBeDisabled();

    await input.press("Escape");
    await expect(input).toBeHidden();
    await expect(window.locator(".diff-viewer")).toBeVisible();

    await window.keyboard.press("Escape");
    await expect(window.locator(".diff-viewer")).toBeHidden();
  });

  test("does not search the previous editor document for a binary file", async () => {
    await window.locator(".file-row", { hasText: "search-target.txt" }).click();
    await expect(window.locator(".diff-viewer")).toBeVisible();
    await window.keyboard.press("Control+f");
    await window.getByRole("textbox", { name: "Find in file" }).fill("needle");
    await expect(window.locator(".dv-find-count")).toHaveText("1 of 3");

    await window.locator(".file-row", { hasText: "binary-target.bin" }).click();
    await expect(window.getByText("Binary file — no text diff available.")).toBeVisible();

    await window.keyboard.press("Control+f");
    const input = window.getByRole("textbox", { name: "Find in file" });
    await input.fill("needle");

    await expect(window.locator(".dv-find-count")).toHaveText("No results");
    await expect(window.getByRole("button", { name: "Previous match" })).toBeDisabled();
    await expect(window.getByRole("button", { name: "Next match" })).toBeDisabled();
  });

  test("keeps large result sets navigable without decorating every hit", async () => {
    await window.locator(".file-row", { hasText: "large-target.txt" }).click();
    await window.keyboard.press("Control+f");
    await window.getByRole("textbox", { name: "Find in file" }).fill("hit");

    await expect(window.locator(".dv-find-count")).toHaveText("1 of 10000");
    await expect(window.locator(".cm-file-search-match-active")).toHaveCount(1);
    expect(await window.locator(".cm-file-search-match").count()).toBeLessThanOrEqual(2_001);

    await window.getByRole("button", { name: "Next match" }).click();
    await expect(window.locator(".dv-find-count")).toHaveText("2 of 10000");
    await expect(window.locator(".cm-file-search-match-active")).toHaveCount(1);
    await window.getByRole("button", { name: "Previous match" }).click();
    await window.getByRole("button", { name: "Previous match" }).click();
    await expect(window.locator(".dv-find-count")).toHaveText("10000 of 10000");
    await expect(window.locator(".cm-file-search-match-active")).toHaveCount(1);
  });

  test("does not move search focus outside an open modal", async () => {
    await window.locator(".file-row", { hasText: "search-target.txt" }).click();
    await expect(window.getByRole("textbox", { name: "Find in file" })).toBeHidden();

    await window.getByRole("button", { name: "File Manager", exact: true }).click();
    const dialog = window.getByRole("dialog", { name: "File Manager" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();

    await window.keyboard.press("Control+f");
    await expect(window.getByRole("textbox", { name: "Find in file" })).toBeHidden();
    expect(
      await window.evaluate(() =>
        Boolean(document.querySelector('[aria-modal="true"]')?.contains(document.activeElement)),
      ),
    ).toBe(true);

    await dialog.getByRole("button", { name: "Close" }).click();

    await window.getByRole("button", { name: "Actions", exact: true }).click();
    await window.getByText("Commit identity…", { exact: true }).click();
    const identityInput = window.getByPlaceholder("Ada Lovelace");
    await expect(identityInput).toBeFocused();
    await window.keyboard.press("Control+f");
    await expect(window.getByRole("textbox", { name: "Find in file" })).toBeHidden();
    await expect(identityInput).toBeFocused();
    await window.locator(".acct-dialog").getByRole("button", { name: "Close" }).click();
  });

  test("lets blocking overlays consume shortcuts without closing the underlying search", async () => {
    await window.keyboard.press("Control+f");
    const input = window.getByRole("textbox", { name: "Find in file" });
    await input.fill("needle");
    await expect(window.locator(".dv-find-count")).toHaveText("1 of 3");

    await window.getByRole("button", { name: "File Manager", exact: true }).click();
    const dialog = window.getByRole("dialog", { name: "File Manager" });
    await expect(dialog).toBeVisible();
    await window.keyboard.press("Escape");

    await expect(dialog).toBeHidden();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("needle");
    await expect(window.locator(".dv-find-count")).toHaveText("1 of 3");

    await window.getByTitle("Discard all changes").click();
    const confirmation = window.getByRole("alertdialog", { name: "Confirm action" });
    const discard = confirmation.getByRole("button", { name: "Discard", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(discard).toBeFocused();
    await window.keyboard.press("Control+f");
    await expect(discard).toBeFocused();

    await window.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("needle");
  });
});
