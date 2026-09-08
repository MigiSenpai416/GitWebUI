import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

for (const count of [1500, 10000]) {
  test(`commit search stays virtualized and idle with ${count} commits`, async () => {
    const root = makeRepo();
    let started: TestApp | undefined;
    try {
      const records: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const message = `History ${index}\n\n${index % 500 === 0 ? "needle" : "ordinary"} description\n`;
        records.push(`commit refs/heads/main\ncommitter Performance <perf@example.com> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`);
      }
      execFileSync("git", ["-C", root, "fast-import", "--quiet", "--force"], { input: records.join(""), stdio: ["pipe", "pipe", "pipe"] });
      started = await launchApp();
      const window = await started.app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      await window.getByRole("button", { name: "Open", exact: true }).first().click();
      await window.locator(".picker-form input").fill(root);
      await window.locator(".picker-form button[type=submit]").click();
      await expect(window.locator(".commit-row").first()).toBeVisible();
      const requests: string[] = [];
      window.on("request", (request) => {
        if (/\/api\/commits\/(?:search|batch)/.test(request.url())) requests.push(request.url());
      });
      const cdp = await window.context().newCDPSession(window);
      await cdp.send("Performance.enable");
      const metrics = async () => {
        const result = await cdp.send("Performance.getMetrics");
        return Object.fromEntries(result.metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]));
      };
      await window.getByRole("button", { name: "Search", exact: true }).click();
      const input = window.getByRole("textbox", { name: "Find in commits" });
      const before = await metrics();
      const searchStart = performance.now();
      await input.fill("needle");
      await expect(window.locator(".commit-find-count")).toHaveText(`1 of ${count / 500}`);
      await expect(window.locator(".search-active")).toBeVisible();
      const searchMs = performance.now() - searchStart;
      await input.press("Shift+Enter");
      await expect(window.locator(".search-active")).toContainText("History 0");
      await expect(window.locator(".cd-body")).toContainText("needle description");
      await expect(window.locator(".commit-placeholder")).toHaveCount(0);
      const rowCount = await window.locator(".commit-row").count();
      expect(rowCount).toBeLessThan(100);
      const idleBefore = await metrics();
      const idleRequestCount = requests.length;
      await window.waitForTimeout(1000);
      const idleAfter = await metrics();
      expect(requests).toHaveLength(idleRequestCount);
      const fullStart = performance.now();
      await window.getByTitle("Show full commit graph", { exact: true }).click();
      await expect(window.locator(".search-active .full-graph-svg")).toBeVisible();
      const fullMs = performance.now() - fullStart;
      const navigationStart = performance.now();
      await input.press("Enter");
      await expect(window.locator(".search-active")).toContainText(`History ${count - 500}`);
      const navigationMs = performance.now() - navigationStart;
      const after = await metrics();
      console.log(JSON.stringify({
        commits: count, searchMs: Math.round(searchMs), fullGraphMs: Math.round(fullMs),
        navigationMs: Math.round(navigationMs), renderedRows: rowCount,
        requests: requests.length, idleTaskMs: Math.round((idleAfter.TaskDuration - idleBefore.TaskDuration) * 1000),
        rendererTaskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
        heapGrowthMiB: Math.round((after.JSHeapUsedSize - before.JSHeapUsedSize) / 1024 / 1024),
      }));
      let active = 0;
      let peak = 0;
      let batches = 0;
      await window.route("**/api/commits/batch?**", async (route) => {
        active += 1;
        peak = Math.max(peak, active);
        batches += 1;
        try {
          const response = await route.fetch();
          await new Promise((resolve) => setTimeout(resolve, 150));
          await route.fulfill({ response });
        } finally {
          active -= 1;
        }
      });
      for (let index = 0; index < 30; index += 1) {
        await window.locator(".commit-scroll").evaluate((element, offset) => { element.scrollTop = offset; }, Math.floor(count * index / 30) * 28);
        await window.waitForTimeout(10);
      }
      await window.locator(".commit-scroll").evaluate((element, offset) => { element.scrollTop = offset; }, Math.floor(count / 2) * 28);
      await expect(window.locator(".commit-placeholder")).toHaveCount(0);
      await expect.poll(() => active).toBe(0);
      expect(peak).toBeLessThanOrEqual(2);
      expect(batches).toBeGreaterThan(0);
      expect(await window.locator(".commit-row").count()).toBeLessThan(100);
      console.log(JSON.stringify({ commits: count, scrollPositions: 30, batchRequests: batches, peakConcurrentBatches: peak }));
    } finally {
      await started?.app.close().catch(() => {});
      if (started) await cleanupApp(started);
      await removeRepo(root);
    }
  });
}
