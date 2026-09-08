import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test.describe.serial("repository commit search", () => {
  let started: TestApp;
  let window: Page;
  let root = "";
  let old = "";

  test.beforeAll(async () => {
    root = makeRepo();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
    writeFileSync(path.join(root, "body.txt"), "search fixture\n");
    git("add", "body.txt");
    git("commit", "--allow-empty", "-m", "Old body match", "-m", "First paragraph\n\nDeep NEEDLE [x] description");
    old = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    let parent = old;
    for (let index = 0; index < 240; index += 1) {
      parent = git("commit-tree", tree, "-p", parent, "-m", `Filler ${index}`);
    }
    git("update-ref", "refs/heads/main", parent);
    git("commit", "--allow-empty", "-m", "needle [x] latest title");
    const hidden = git("commit-tree", tree, "-p", old, "-m", "needle [x] hidden branch");
    git("update-ref", "refs/heads/hidden", hidden);
    started = await launchApp();
    window = await started.app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.getByRole("button", { name: "Open", exact: true }).first().click();
    await window.locator(".picker-form input").fill(root);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.locator(".commit-row", { hasText: "latest title" })).toBeVisible();
  });

  test.afterAll(async () => {
    await started?.app.close().catch(() => {});
    if (started) await cleanupApp(started);
    if (root) await removeRepo(root);
  });

  test("finds full descriptions beyond pagination and hidden branches, dims misses, and wraps", async () => {
    await window.getByRole("button", { name: "Search", exact: true }).click();
    const input = window.getByRole("textbox", { name: "Find in commits" });
    await expect(input).toBeFocused();
    await input.fill("needle [x]");
    await expect(window.locator(".commit-find-count")).toHaveText("1 of 3");
    await expect(window.locator(".search-active")).toBeVisible();
    await expect(window.locator(".search-miss").first()).toHaveCSS("opacity", "0.3");
    await window.getByRole("button", { name: "Previous commit match" }).click();
    await expect(input).toBeFocused();
    await expect(window.locator(".commit-find-count")).toHaveText("3 of 3");
    await expect(window.locator(`.search-active[data-commit-hash="${old}"]`)).toBeVisible();
    await expect(window.locator(".cd-body")).toContainText("Deep NEEDLE [x] description");
    expect(await window.locator(".commit-scroll").evaluate((element) => element.scrollTop)).toBeGreaterThan(5000);
    await input.press("Enter");
    await expect(window.locator(".commit-find-count")).toHaveText("1 of 3");
    await window.getByRole("button", { name: "Next commit match" }).click();
    await expect(window.locator(".commit-find-count")).toHaveText("2 of 3");
    await input.press("Shift+Enter");
    await expect(window.locator(".commit-find-count")).toHaveText("1 of 3");
    await window.getByTitle("Show full commit graph", { exact: true }).click();
    await expect(window.locator(".search-active .full-graph-svg")).toBeVisible();
    await window.screenshot({ path: test.info().outputPath("commit-search.png") });
  });

  test("shows misses, restores history when cleared, and closes with Escape", async () => {
    const input = window.getByRole("textbox", { name: "Find in commits" });
    await input.fill("not-present-anywhere");
    await expect(window.locator(".commit-find-count")).toHaveText("No results");
    await expect(window.getByRole("button", { name: "Next commit match" })).toBeDisabled();
    await expect(window.locator(".search-hit")).toHaveCount(0);
    await input.fill("");
    await expect(window.locator(".search-miss")).toHaveCount(0);
    await expect(window.locator(".commit-row", { hasText: "latest title" })).toBeVisible();
    await input.press("Escape");
    await expect(input).not.toBeVisible();
    await expect(window.getByRole("button", { name: "Search", exact: true })).toHaveAttribute("aria-pressed", "false");
  });

  test("Escape in commit search leaves an open diff intact", async () => {
    await window.getByRole("button", { name: "Search", exact: true }).click();
    const input = window.getByRole("textbox", { name: "Find in commits" });
    await input.fill("Deep NEEDLE");
    await expect(window.locator(".commit-find-count")).toHaveText("1 of 1");
    await window.locator(".commit-details .file-row", { hasText: "body.txt" }).click();
    await expect(window.locator(".diff-viewer")).toBeVisible();
    await input.press("Escape");
    await expect(input).not.toBeVisible();
    await expect(window.locator(".diff-viewer")).toBeVisible();
  });
});
