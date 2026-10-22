import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { callLog, cleanupApp, launchApp, makeRepo, removeRepo, stubRoute, type TestApp } from "./helpers";

interface BatchTestState {
  active: number;
  peak: number;
  batches: number;
}

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
      const app = started.app;
      const searchCalls = async () =>
        (await callLog(app, "searchCommits")).length + (await callLog(app, "commitsByHash")).length;
      const callsBefore = await searchCalls();
      const requests = async () => (await searchCalls()) - callsBefore;
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
      const idleRequestCount = await requests();
      await window.waitForTimeout(1000);
      const idleAfter = await metrics();
      expect(await requests()).toBe(idleRequestCount);
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
        requests: await requests(), idleTaskMs: Math.round((idleAfter.TaskDuration - idleBefore.TaskDuration) * 1000),
        rendererTaskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
        heapGrowthMiB: Math.round((after.JSHeapUsedSize - before.JSHeapUsedSize) / 1024 / 1024),
      }));
      await app.evaluate(() => {
        (globalThis as unknown as { batchTest: BatchTestState }).batchTest = { active: 0, peak: 0, batches: 0 };
      });
      await stubRoute(app, "commitsByHash", async (_input, proceed) => {
        const state = (globalThis as unknown as { batchTest: BatchTestState }).batchTest;
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        state.batches += 1;
        try {
          const reply = await proceed();
          await new Promise((resolve) => setTimeout(resolve, 150));
          return reply;
        } finally {
          state.active -= 1;
        }
      });
      const batchTest = () => app.evaluate(() => (globalThis as unknown as { batchTest: BatchTestState }).batchTest);
      for (let index = 0; index < 30; index += 1) {
        await window.locator(".commit-scroll").evaluate((element, offset) => { element.scrollTop = offset; }, Math.floor(count * index / 30) * 28);
        await window.waitForTimeout(10);
      }
      await window.locator(".commit-scroll").evaluate((element, offset) => { element.scrollTop = offset; }, Math.floor(count / 2) * 28);
      await expect(window.locator(".commit-placeholder")).toHaveCount(0);
      await expect.poll(async () => (await batchTest()).active).toBe(0);
      const { peak, batches } = await batchTest();
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
