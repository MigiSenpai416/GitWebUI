import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { cleanupApp, launchApp, type TestApp } from "./helpers";

function makeGraphRepo(): string {
  const dir = path.join(os.tmpdir(), `gitwebui-e2e-graph-${randomBytes(6).toString("hex")}`);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  const gitText = (...args: string[]) => git(...args).toString().trim();
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  git("config", "user.email", "graph@example.com");
  git("config", "user.name", "Graph Test");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "Graph root");
  git("branch", "feature");
  git("commit", "--allow-empty", "-m", "Main work");
  git("switch", "feature");
  git("commit", "--allow-empty", "-m", "Feature work");
  git("switch", "main");
  git("merge", "--no-ff", "feature", "-m", "Merge feature");
  const root = gitText("rev-list", "--max-parents=0", "HEAD");
  const tree = gitText("rev-parse", "HEAD^{tree}");
  const parents = [gitText("rev-parse", "HEAD")];
  for (let index = 1; index < 25; index += 1) {
    parents.push(gitText("commit-tree", tree, "-p", root, "-m", `Wide parent ${index}`));
  }
  const mergeArgs = parents.flatMap((parent) => ["-p", parent]);
  const wideMerge = gitText("commit-tree", tree, ...mergeArgs, "-m", "Wide merge");
  git("update-ref", "refs/heads/main", wideMerge);
  return dir;
}

async function openRepo(window: Page, repoDir: string): Promise<void> {
  await window.getByRole("button", { name: "Open" }).first().click();
  await window.locator(".picker-form input").fill(repoDir);
  await window.locator(".picker-form button[type=submit]").click();
  await expect(window.getByText("Merge feature").first()).toBeVisible();
}

test("full commit graph is opt-in, parent-aware, and persisted for the repository", async () => {
  const repoDir = makeGraphRepo();
  let started: TestApp | undefined;
  let app: ElectronApplication | undefined;

  try {
    started = await launchApp();
    app = started.app;
    let window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await openRepo(window, repoDir);

    const toggle = window.locator(".graph-mode-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toContainText("Linear");
    await expect(window.locator(".full-graph-svg")).toHaveCount(0);

    const mergeRow = window.locator(".commit-row").filter({ hasText: "Merge feature" });
    await mergeRow.click();
    await expect(mergeRow).toHaveClass(/selected/);
    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toContainText("Full");
    await expect(mergeRow.locator('[data-edge="parent"]')).toHaveCount(2);
    const mergeTargets = await mergeRow.locator('[data-edge="parent"]').evaluateAll((edges) =>
      edges.map((edge) => edge.getAttribute("data-to-lane")),
    );
    expect(new Set(mergeTargets).size).toBe(2);
    await expect(mergeRow).toHaveClass(/selected/);

    const wideRow = window.locator(".commit-row").filter({ hasText: "Wide merge" });
    await expect(wideRow.locator('[data-edge="parent"]')).toHaveCount(25);
    const list = window.locator(".commit-list");
    const dimensions = await list.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
    await list.evaluate((element) => {
      element.scrollLeft = element.scrollWidth - element.clientWidth;
    });
    const alignment = await list.evaluate((element) => {
      const header = element.querySelector(".col-graph-head")?.getBoundingClientRect();
      const row = element.querySelector(".commit-row .col-graph")?.getBoundingClientRect();
      return { header: header?.left, row: row?.left };
    });
    expect(alignment.header).toBe(alignment.row);

    await app.close();
    app = undefined;
    const restarted = await launchApp({ reuse: started });
    app = restarted.app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.getByText("Merge feature").first()).toBeVisible();
    await expect(window.locator(".graph-mode-toggle")).toHaveAttribute("aria-pressed", "true");

    await window.locator(".graph-mode-toggle").click();
    await expect(window.locator(".full-graph-svg")).toHaveCount(0);
    await expect(
      window.locator(".commit-row").filter({ hasText: "Merge feature" }).locator(".graph-line"),
    ).toHaveCount(1);
  } finally {
    await app?.close().catch(() => {});
    if (started) await cleanupApp(started);
    await fs.rm(repoDir, { recursive: true, force: true });
  }
});
