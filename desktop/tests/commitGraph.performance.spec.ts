import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

for (const { count, lanes } of [{ count: 10000, lanes: 8 }, { count: 50000, lanes: 8 }, { count: 10000, lanes: 40 }]) {
  test(`main pinning stays responsive with ${count} commits and ${lanes} feature paths`, async () => {
    const root = makeRepo();
    let started: TestApp | undefined;
    try {
      const records: string[] = [];
      let main = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      let mark = 0;
      const add = (ref: string, parent: string, merge?: string) => {
        mark += 1;
        const message = `History ${mark}${merge ? " merge" : " work"}\n`;
        records.push(`commit refs/heads/${ref}\nmark :${mark}\ncommitter Performance <perf@example.com> ${1700000000 + mark} +0000\ndata ${Buffer.byteLength(message)}\n${message}from ${parent}\n${merge ? `merge ${merge}\n` : ""}\n`);
        return `:${mark}`;
      };
      for (let batch = 0; batch < count / (lanes * 5); batch += 1) {
        const branches = Array<string>(lanes).fill(main);
        for (let round = 0; round < 4; round += 1) {
          for (let lane = 0; lane < branches.length; lane += 1) branches[lane] = add(`feature-${lane}`, branches[lane]);
        }
        for (const branch of branches) main = add("main", main, branch);
      }
      add("active-work", main);
      execFileSync("git", ["-C", root, "fast-import", "--quiet", "--force"], { input: records.join(""), stdio: ["pipe", "pipe", "pipe"] });
      execFileSync("git", ["-C", root, "symbolic-ref", "HEAD", "refs/heads/active-work"]);
      const tip = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      started = await launchApp();
      const window = await started.app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      await window.getByRole("button", { name: "Open", exact: true }).first().click();
      await window.locator(".picker-form input").fill(root);
      await window.locator(".picker-form button[type=submit]").click();
      await expect(window.locator(".commit-row").first()).toBeVisible();
      await expect(window.locator(".sb-branch-checkout")).toHaveCount(lanes + 2);
      let pinRequests = 0;
      window.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/commits/main-history") pinRequests += 1;
      });
      const cdp = await window.context().newCDPSession(window);
      await cdp.send("Performance.enable");
      const metrics = async () => {
        const result = await cdp.send("Performance.getMetrics");
        return Object.fromEntries(result.metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]));
      };
      await window.getByRole("button", { name: "Search", exact: true }).click();
      const searchResponse = window.waitForResponse((response) => new URL(response.url()).pathname === "/api/commits/search");
      await window.getByRole("textbox", { name: "Find in commits" }).fill(`History ${count + 1} work`);
      const search = await (await searchResponse).json();
      expect(search.rows).toHaveLength(count + 2);
      await expect(window.locator(".commit-find-count")).toHaveText("1 of 1");
      await expect(window.locator(".commit-placeholder")).toHaveCount(0);
      const before = await metrics();
      const pinResponse = window.waitForResponse((response) => new URL(response.url()).pathname === "/api/commits/main-history");
      const coldStart = performance.now();
      await window.locator(".graph-mode-toggle").click();
      await expect(window.locator(`.full-graph-node[data-commit-hash="${tip}"]`)).toHaveAttribute("data-node-lane", "1");
      const coldMs = performance.now() - coldStart;
      const response = await pinResponse;
      await response.finished();
      const pinLookupMs = response.request().timing().responseEnd;
      const pinned = new Set<string>((await response.json()).hashes);
      expect(pinned.size).toBe(count / 5 + 1);
      const scrollStart = performance.now();
      for (let index = 0; index < 30; index += 1) {
        await window.locator(".commit-scroll").evaluate((element, offset) => {
          element.scrollTop = offset;
          return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }, Math.floor((count + 2) * index / 29) * 28);
      }
      await expect(window.locator(".commit-placeholder")).toHaveCount(0);
      const scrollMs = performance.now() - scrollStart;
      const nodes = await window.locator(".full-graph-node").evaluateAll((entries) => entries.map((entry) => ({
        hash: entry.getAttribute("data-commit-hash")!, lane: Number(entry.getAttribute("data-node-lane")),
      })));
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.length).toBeLessThan(100);
      for (const node of nodes) {
        if (pinned.has(node.hash)) expect(node.lane).toBe(0);
        else expect(node.lane).toBeGreaterThan(0);
      }
      await window.locator(".graph-mode-toggle").click();
      const cachedStart = performance.now();
      await window.locator(".graph-mode-toggle").click();
      await expect.poll(() => window.locator(".full-graph-svg").count()).toBeGreaterThan(0);
      const cachedMs = performance.now() - cachedStart;
      await expect(window.getByText("Loading commit graph…", { exact: true })).toHaveCount(0);
      const idleBefore = await metrics();
      const idleRequests = pinRequests;
      await window.waitForTimeout(1000);
      const after = await metrics();
      expect(pinRequests).toBe(idleRequests);
      expect(pinRequests).toBe(2);
      console.log(JSON.stringify({
        commits: count + 2, merges: count / 5, featurePaths: lanes, coldFullMs: Math.round(coldMs), pinLookupMs: Math.round(pinLookupMs),
        cachedFullMs: Math.round(cachedMs), scroll30PositionsMs: Math.round(scrollMs), renderedRows: nodes.length,
        pinRequests, idleTaskMs: Math.round((after.TaskDuration - idleBefore.TaskDuration) * 1000),
        rendererTaskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
        heapGrowthMiB: Math.round((after.JSHeapUsedSize - before.JSHeapUsedSize) / 1024 / 1024),
      }));
    } finally {
      await started?.app.close().catch(() => {});
      if (started) await cleanupApp(started);
      await removeRepo(root);
    }
  });
}
