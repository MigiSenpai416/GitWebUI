import { test, expect } from "@playwright/test";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo } from "./helpers";

test("reorders repository tabs by dragging and persists the order", async () => {
  const roots = [makeRepo(), makeRepo(), makeRepo()];
  const tabs = roots.map((root, index) => ({
    id: String.fromCharCode(97 + index),
    root,
    name: path.basename(root),
    branch: "main",
  }));
  const started = await launchApp();
  const app = started.app;
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  await window.evaluate((savedTabs) => {
    localStorage.setItem("gwui.tabs", JSON.stringify({ tabs: savedTabs, activeTabId: "b" }));
  }, tabs);
  await window.reload();

  const tabItems = window.locator(".tabbar-tabs .tab");
  const tabNames = tabItems.locator(".tab-name");
  await expect(tabNames).toHaveText(tabs.map((tab) => tab.name));

  const summary = window.getByPlaceholder("Commit summary");
  await tabItems.nth(0).dragTo(summary);
  await expect(summary).toHaveValue("");
  await expect(tabNames).toHaveText(tabs.map((tab) => tab.name));

  await tabItems.nth(0).locator(".tab-close").dragTo(tabItems.nth(2));
  await expect(tabNames).toHaveText(tabs.map((tab) => tab.name));

  const firstBox = await tabItems.nth(0).boundingBox();
  const lastBox = await tabItems.nth(2).boundingBox();
  const addBox = await window.locator(".tab-add").boundingBox();
  expect(firstBox).not.toBeNull();
  expect(lastBox).not.toBeNull();
  expect(addBox).not.toBeNull();
  await window.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2);
  await window.mouse.down();
  await window.mouse.move(lastBox!.x + lastBox!.width * 0.75, lastBox!.y + lastBox!.height / 2, {
    steps: 10,
  });
  await expect(tabItems.nth(2)).toHaveClass(/drop-after/);
  await window.mouse.move(addBox!.x + addBox!.width / 2, addBox!.y + addBox!.height / 2);
  await expect(window.locator(".tab.drop-before, .tab.drop-after")).toHaveCount(0);
  await window.mouse.up();
  await expect(tabNames).toHaveText(tabs.map((tab) => tab.name));

  const summaryBox = await summary.boundingBox();
  expect(summaryBox).not.toBeNull();
  await window.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2);
  await window.mouse.down();
  await window.mouse.move(lastBox!.x + lastBox!.width * 0.75, lastBox!.y + lastBox!.height / 2, {
    steps: 10,
  });
  await expect(tabItems.nth(2)).toHaveClass(/drop-after/);
  await window.mouse.move(
    summaryBox!.x + summaryBox!.width / 2,
    summaryBox!.y + summaryBox!.height / 2,
  );
  await expect(window.locator(".tab.drop-before, .tab.drop-after")).toHaveCount(0);
  await window.mouse.up();
  await expect(tabNames).toHaveText(tabs.map((tab) => tab.name));

  await tabItems.nth(0).dragTo(tabItems.nth(2), {
    targetPosition: { x: lastBox!.width * 0.75, y: lastBox!.height / 2 },
  });

  await expect(tabNames).toHaveText([tabs[1].name, tabs[2].name, tabs[0].name]);
  await expect(window.locator(".tab.active .tab-name")).toHaveText(tabs[1].name);

  const middleBox = await tabItems.nth(1).boundingBox();
  expect(middleBox).not.toBeNull();
  await tabItems.nth(2).dragTo(tabItems.nth(1), {
    targetPosition: { x: middleBox!.width * 0.25, y: middleBox!.height / 2 },
  });

  const reordered = [tabs[1], tabs[0], tabs[2]];
  await expect(tabNames).toHaveText(reordered.map((tab) => tab.name));
  const saved = await window.evaluate(() => JSON.parse(localStorage.getItem("gwui.tabs") ?? "{}"));
  expect(saved).toEqual({ tabs: reordered, activeTabId: "b" });

  await app.close();
  const restarted = (await launchApp({ reuse: started })).app;
  const reopened = await restarted.firstWindow();
  await reopened.waitForLoadState("domcontentloaded");
  await expect(reopened.locator(".tabbar-tabs .tab-name"))
    .toHaveText(reordered.map((tab) => tab.name));
  await expect(reopened.locator(".tab.active .tab-name")).toHaveText(tabs[1].name);

  await restarted.close();
  await cleanupApp(started);
  await Promise.all(roots.map(removeRepo));
});
