import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test.describe("File history", () => {
  let started: TestApp;
  let app: ElectronApplication;
  let window: Page;
  let repoDir = "";

  test.beforeAll(async () => {
    repoDir = makeRepo();
    const original = Array.from({ length: 180 }, (_, index) => `unchanged line ${index + 1}`);
    original[79] = "vanishing phrase";
    original[149] = "original ending";
    await fs.writeFile(path.join(repoDir, "story.txt"), `${original.join("\n")}\n`);
    commit(repoDir, "Add remembered phrase", "story.txt");

    execFileSync("git", ["-C", repoDir, "config", "user.name", "History Editor"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "history@example.com"], { stdio: "pipe" });
    const replacement = [...original];
    replacement[79] = "replacement phrase";
    replacement[149] = "revised ending";
    await fs.writeFile(path.join(repoDir, "story.txt"), `${replacement.join("\n")}\n`);
    commit(repoDir, "Replace remembered phrase", "story.txt");
    execFileSync("git", ["-C", repoDir, "mv", "story.txt", "renamed-story.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "Rename story"], { stdio: "pipe" });

    started = await launchApp();
    app = started.app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.getByRole("button", { name: "Open" }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.getByText("Rename story").first()).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    await cleanupApp(started);
    await removeRepo(repoDir);
  });

  test("follows renames and finds where remembered text disappeared", async () => {
    await window.getByRole("button", { name: "File Manager", exact: true }).click();
    const dialog = window.getByRole("dialog", { name: "File Manager" });
    const file = dialog.locator('.fm-row[title="renamed-story.txt"]');
    await file.locator(".fm-row-main").click();
    await dialog.getByRole("button", { name: "History selected" }).click();

    const history = dialog.getByRole("region", { name: "File history for renamed-story.txt" });
    await expect(history).toBeVisible();
    await expect(history.locator(".fh-entry")).toHaveCount(3);
    await expect(history.locator(".fh-entry").nth(0)).toContainText("Rename story");
    await expect(history.locator(".fh-entry").nth(1)).toContainText("Replace remembered phrase");
    await expect(history.locator(".fh-entry").nth(2)).toContainText("Add remembered phrase");
    await expect(history.locator(".fh-entry").first()).toContainText("story.txt → renamed-story.txt");

    await history.locator(".fh-entry").filter({ hasText: "Replace remembered phrase" }).click();
    await expect(history.locator(".fh-commit-title")).toContainText("History Editor");
    await expect(history.locator(".fh-diff-summary .added")).toHaveText("+2 added");
    await expect(history.locator(".fh-diff-summary .deleted")).toHaveText("−2 deleted");
    await expect(history.locator(".cm-diff-del").filter({ hasText: "vanishing phrase" })).toHaveCount(1);
    await expect(history.locator(".cm-diff-add").filter({ hasText: "replacement phrase" })).toHaveCount(1);
    await expect(history.locator(".fh-hunk-nav")).toContainText("Change 1 of 2");
    const firstScroll = await history.locator(".fh-diff-editor .cm-scroller").evaluate((element) => element.scrollTop);
    expect(firstScroll).toBeGreaterThan(0);
    await history.getByRole("button", { name: "Next change" }).click();
    await expect(history.locator(".fh-hunk-nav")).toContainText("Change 2 of 2");
    const secondScroll = await history.locator(".fh-diff-editor .cm-scroller").evaluate((element) => element.scrollTop);
    expect(secondScroll).toBeGreaterThan(firstScroll);
    await history.getByRole("button", { name: "Previous change" }).click();
    await expect(history.locator(".fh-hunk-nav")).toContainText("Change 1 of 2");

    await history.getByRole("button", { name: "View complete file" }).click();
    const preview = dialog.getByRole("region", { name: "Preview story.txt" });
    await expect(preview).toBeVisible();
    await expect(preview.locator(".fm-preview-revision")).toContainText("Commit");
    await preview.getByRole("button", { name: "Find" }).click();
    await preview.getByLabel("Find in file").fill("replacement phrase");
    await expect(preview.locator(".fm-preview-find-count")).toHaveText("1 of 1");
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");
    await expect(history).toBeVisible();
    await expect(history.getByRole("button", { name: "View complete file" })).toBeFocused();

    await history.getByRole("button", { name: "Blame this revision" }).click();
    const blame = dialog.getByRole("region", { name: "Git blame for story.txt" });
    await expect(blame).toBeVisible();
    await expect(blame.locator(".blame-summary .head")).toContainText("Commit");
    await expect(blame.locator(".blame-snapshot-note")).toContainText("pinned to this historical file image");
    await window.keyboard.press("Escape");
    await expect(history).toBeVisible();
    await expect(history.getByRole("button", { name: "Blame this revision" })).toBeFocused();

    await history.getByLabel("Remember code that disappeared?").fill("vanishing phrase");
    await history.getByRole("button", { name: "Find" }).click();
    await expect(history.locator(".fh-search-active")).toContainText("vanishing phrase");
    await expect(history.locator(".fh-entry")).toHaveCount(2);
    await expect(history.locator(".fh-entry").filter({ hasText: "Rename story" })).toHaveCount(0);
    await expect(history.locator(".fh-entry").nth(0)).toContainText("Replace remembered phrase");
    await expect(history.locator(".fh-entry").nth(1)).toContainText("Add remembered phrase");
    await expect(history.locator(".cm-diff-del")).toContainText("vanishing phrase");

    await history.getByLabel("Remember code that disappeared?").fill("x".repeat(2_001));
    await history.getByRole("button", { name: "Find" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Remembered text is too long to search");
    await expect(history.locator(".fh-search-active")).toContainText("vanishing phrase");
    await expect(history.locator(".fh-entry")).toHaveCount(2);
  });
});

function commit(repoDir: string, message: string, file: string): void {
  execFileSync("git", ["-C", repoDir, "add", "--", file], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", message], { stdio: "pipe" });
}
