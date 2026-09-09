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
    await expect(mergeRow.locator("rect.graph-node")).toHaveCount(1);
    await expect(window.locator(".commit-row").filter({ hasText: "Feature work" }).locator("circle.graph-node")).toHaveCount(1);
    await mergeRow.click();
    await expect(mergeRow).toHaveClass(/selected/);
    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toContainText("Full");
    await expect(mergeRow.locator("rect.full-graph-node")).toHaveCount(1);
    await expect(window.locator(".commit-row").filter({ hasText: "Feature work" }).locator("circle.full-graph-node")).toHaveCount(1);
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

test("main stays left while a newer feature is checked out and while searching", async () => {
  const repoDir = makeGraphRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
  const main = git("rev-parse", "main");
  const pinned = new Set(git("rev-list", "--first-parent", "main").split("\n"));
  git("switch", "-c", "active-work");
  git("commit", "--allow-empty", "-m", "Newest feature work");
  const feature = git("rev-parse", "HEAD");
  let started: TestApp | undefined;
  try {
    started = await launchApp();
    const window = await started.app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await openRepo(window, repoDir);
    await window.locator(".graph-mode-toggle").click();
    await expect(window.locator(".graph-mode-toggle")).toHaveAttribute("title", /Main history pinned left/);
    await expect(window.locator(`.full-graph-node[data-commit-hash="${main}"]`)).toHaveAttribute("data-node-lane", "0");
    await expect(window.locator(`.full-graph-node[data-commit-hash="${feature}"]`)).toHaveAttribute("data-node-lane", "1");
    const checkLanes = async () => {
      const nodes = await window.locator(".full-graph-node").evaluateAll((entries) => entries.map((entry) => ({
        hash: entry.getAttribute("data-commit-hash")!, lane: Number(entry.getAttribute("data-node-lane")),
      })));
      expect(nodes.length).toBeGreaterThan(1);
      for (const node of nodes) {
        if (pinned.has(node.hash)) expect(node.lane).toBe(0);
        else expect(node.lane).toBeGreaterThan(0);
      }
    };
    await checkLanes();
    await window.getByRole("button", { name: "Search", exact: true }).click();
    await window.getByRole("textbox", { name: "Find in commits" }).fill("Newest feature work");
    await expect(window.locator(".commit-find-count")).toHaveText("1 of 1");
    await expect(window.locator(`.full-graph-node[data-commit-hash="${main}"]`)).toHaveAttribute("data-node-lane", "0");
    await checkLanes();
    expect(git("branch", "--show-current")).toBe("active-work");
  } finally {
    await started?.app.close().catch(() => {});
    if (started) await cleanupApp(started);
    await fs.rm(repoDir, { recursive: true, force: true });
  }
});

test("an unchanged repository refresh keeps main pinned while requests are in flight", async () => {
  const repoDir = makeGraphRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
  git("switch", "-c", "active-work");
  git("commit", "--allow-empty", "-m", "Newest feature work");
  const feature = git("rev-parse", "HEAD");
  let started: TestApp | undefined;
  let release: (() => void) | undefined;
  try {
    started = await launchApp();
    const window = await started.app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await openRepo(window, repoDir);
    await window.locator(".graph-mode-toggle").click();
    await expect(window.locator(".graph-mode-toggle")).toHaveAttribute("title", /Main history pinned left/);
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await window.route("**/api/commits/main-history", async (route) => {
      await pending;
      await route.continue().catch(() => {});
    });
    const refreshed = window.waitForResponse((response) => new URL(response.url()).pathname === "/api/commits");
    // Focus refreshes are coalesced for 800 ms.
    await window.waitForTimeout(850);
    await window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    await window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(window.locator(`.full-graph-node[data-commit-hash="${feature}"]`)).toHaveAttribute("data-node-lane", "1");
    await expect(window.locator(".graph-mode-toggle")).toHaveAttribute("title", /Main history pinned left/);
    release?.();
    await window.unroute("**/api/commits/main-history");
    git("update-ref", "refs/heads/main", feature);
    const moved = window.waitForResponse((response) => new URL(response.url()).pathname === "/api/commits/main-history");
    await window.waitForTimeout(850);
    await window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await moved;
    await expect(window.locator(`.full-graph-node[data-commit-hash="${feature}"]`)).toHaveAttribute("data-node-lane", "0");
    git("branch", "-D", "main");
    const deleted = window.waitForResponse((response) => new URL(response.url()).pathname === "/api/commits/main-history");
    await window.waitForTimeout(850);
    await window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await deleted;
    await expect(window.locator(".graph-mode-toggle")).not.toHaveAttribute("title", /Main history pinned left/);
  } finally {
    release?.();
    await started?.app.close().catch(() => {});
    if (started) await cleanupApp(started);
    await fs.rm(repoDir, { recursive: true, force: true });
  }
});

for (const scenario of ["delayed", "retry", "no main"] as const) {
  test(`Full mode waits for its final layout: ${scenario}`, async () => {
    const repoDir = makeGraphRepo();
    const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
    if (scenario === "no main") git("branch", "-m", "trunk");
    git("switch", "-c", "active-work");
    git("commit", "--allow-empty", "-m", "Newest feature work");
    const feature = git("rev-parse", "HEAD");
    let started: TestApp | undefined;
    let release: (() => void) | undefined;
    try {
      started = await launchApp();
      const window = await started.app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      await openRepo(window, repoDir);
      await expect(window.locator(".sb-branch-checkout")).toHaveCount(3);
      const order = await window.locator(".commit-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-commit-hash")));
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let attempts = 0;
      await window.route("**/api/commits/main-history", async (route) => {
        attempts += 1;
        if (scenario === "retry" && attempts === 1) {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Temporary lookup failure" }) });
          return;
        }
        await pending;
        await route.continue().catch(() => {});
      });
      await window.locator(".graph-mode-toggle").click();
      if (scenario === "retry") {
        await expect(window.getByText("Could not pin main: Temporary lookup failure")).toBeVisible();
        await expect(window.locator(".commit-row")).toHaveCount(0);
        await window.getByRole("button", { name: "Retry", exact: true }).click();
      }
      await expect(window.locator(".commit-row")).toHaveCount(0);
      await expect(window.getByText("Loading commit graph…", { exact: true })).toBeVisible();
      release?.();
      await expect(window.locator(`.full-graph-node[data-commit-hash="${feature}"]`)).toHaveAttribute("data-node-lane", scenario === "no main" ? "0" : "1");
      await expect(window.getByText("Loading commit graph…", { exact: true })).toHaveCount(0);
      expect(await window.locator(".commit-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-commit-hash")))).toEqual(order);

      await window.locator(".graph-mode-toggle").click();
      const another = new Promise<void>((resolve) => { release = resolve; });
      await window.unroute("**/api/commits/main-history");
      await window.route("**/api/commits/main-history", async (route) => {
        await another;
        await route.continue().catch(() => {});
      });
      await window.locator(".graph-mode-toggle").click();
      await expect(window.locator(`.full-graph-node[data-commit-hash="${feature}"]`)).toHaveAttribute("data-node-lane", scenario === "no main" ? "0" : "1");
      await expect(window.getByText("Loading commit graph…", { exact: true })).toHaveCount(0);
    } finally {
      release?.();
      await started?.app.close().catch(() => {});
      if (started) await cleanupApp(started);
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });
}

test("switching repositories waits for that repository's own graph data", async () => {
  const roots = [makeGraphRepo(), makeGraphRepo()];
  execFileSync("git", ["-C", roots[1], "branch", "-m", "trunk"]);
  const savedRoots = roots.map((root) => root.replace(/\\/g, "/"));
  let started: TestApp | undefined;
  let release: (() => void) | undefined;
  try {
    started = await launchApp();
    const window = await started.app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate((repos) => {
      localStorage.setItem("gwui.tabs", JSON.stringify({
        tabs: repos.map((root, index) => ({ id: String(index), root, name: `Repo ${index}`, branch: index ? "trunk" : "main" })),
        activeTabId: "0",
      }));
      localStorage.setItem("gwui.graphMode", JSON.stringify(Object.fromEntries(repos.map((root) => [root, "full"]))));
    }, savedRoots);
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await window.route("**/api/commits/main-history", async (route) => {
      if (route.request().headers()["x-repo-root"]?.replace(/\\/g, "/") === savedRoots[1]) await pending;
      await route.continue().catch(() => {});
    });
    await window.reload();
    await expect(window.locator(".graph-mode-toggle")).toHaveAttribute("title", /Main history pinned left/);
    await window.locator(".tabbar-tabs .tab").nth(1).click();
    await expect(window.getByText("Loading commit graph…", { exact: true })).toBeVisible();
    await expect(window.locator(".commit-row")).toHaveCount(0);
    release?.();
    await expect(window.locator(".full-graph-node").first()).toBeVisible();
    await expect(window.locator(".graph-mode-toggle")).not.toHaveAttribute("title", /Main history pinned left/);
  } finally {
    release?.();
    await started?.app.close().catch(() => {});
    if (started) await cleanupApp(started);
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  }
});

test("waiting for a changed main tip preserves horizontal graph position", async () => {
  const root = makeGraphRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("switch", "-c", "active-work");
  git("commit", "--allow-empty", "-m", "Newest feature work");
  const feature = git("rev-parse", "HEAD");
  let started: TestApp | undefined;
  let release: (() => void) | undefined;
  try {
    started = await launchApp();
    const window = await started.app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await openRepo(window, root);
    await window.locator(".graph-mode-toggle").click();
    await expect(window.locator(".graph-mode-toggle")).toHaveAttribute("title", /Main history pinned left/);
    const list = window.locator(".commit-list");
    const offset = await list.evaluate((element) => {
      element.scrollLeft = element.scrollWidth - element.clientWidth;
      return element.scrollLeft;
    });
    expect(offset).toBeGreaterThan(0);
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await window.route("**/api/commits/main-history", async (route) => {
      await pending;
      await route.continue().catch(() => {});
    });
    git("update-ref", "refs/heads/main", feature);
    await window.waitForTimeout(850);
    await window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(window.getByText("Loading commit graph…", { exact: true })).toBeVisible();
    expect(await list.evaluate((element) => element.scrollLeft)).toBe(offset);
    release?.();
    await expect(window.locator(`.full-graph-node[data-commit-hash="${feature}"]`)).toHaveAttribute("data-node-lane", "0");
    expect(await list.evaluate((element) => element.scrollLeft)).toBe(offset);
  } finally {
    release?.();
    await started?.app.close().catch(() => {});
    if (started) await cleanupApp(started);
    await fs.rm(root, { recursive: true, force: true });
  }
});
