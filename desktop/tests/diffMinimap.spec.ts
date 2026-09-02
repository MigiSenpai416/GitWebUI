import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test.describe.serial("diff minimap", () => {
  let started: TestApp;
  let app: ElectronApplication;
  let window: Page;
  let repoDir = "";

  test.beforeAll(async () => {
    repoDir = makeRepo();
    await fs.writeFile(
      path.join(repoDir, "minimap-click.cpp"),
      minimapFixture(false, "click-target-marker"),
    );
    await fs.writeFile(
      path.join(repoDir, "minimap-drag.cpp"),
      minimapFixture(false, "drag-target-marker"),
    );
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "minimap fixture"], { stdio: "pipe" });
    await fs.writeFile(
      path.join(repoDir, "minimap-click.cpp"),
      minimapFixture(true, "click-target-marker"),
    );
    await fs.writeFile(
      path.join(repoDir, "minimap-drag.cpp"),
      minimapFixture(true, "drag-target-marker"),
    );

    started = await launchApp();
    app = started.app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await resizeWindow(app, 1_200, 800);

    await window.getByRole("button", { name: "Open" }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.locator(".file-row", { hasText: "minimap-click.cpp" })).toBeVisible();
    await window.locator(".file-row", { hasText: "minimap-click.cpp" }).click();
    await expect(window.locator(".dv-editor-unified .cm-content")).toContainText("click-target-marker");
    await expect(window.locator(".dv-minimap")).toBeVisible();
    await resizeWindow(app, 900, 560);
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    await cleanupApp(started);
    await removeRepo(repoDir);
  });

  test("keeps the first click aligned after wrapped heights settle", async () => {
    await clickMinimapAt(window, 0.4);
    await waitForScrollToSettle(window);

    expect(await minimapCenterError(window, 0.4)).toBeLessThanOrEqual(2);
    expect(await minimapScrollError(window, 0.4)).toBeLessThanOrEqual(2);
  });

  test("keeps a dragged destination aligned", async () => {
    await resizeWindow(app, 1_200, 800);
    await window.locator(".file-row", { hasText: "minimap-drag.cpp" }).click();
    await expect(window.locator(".dv-editor-unified .cm-content")).toContainText("drag-target-marker");
    await expect(window.locator(".dv-minimap")).toBeVisible();
    await resizeWindow(app, 900, 560);
    const minimap = window.locator(".dv-minimap");
    const box = await minimap.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;

    await window.mouse.move(x, box!.y + box!.height * 0.52);
    await window.mouse.down();
    await window.mouse.move(x, box!.y + box!.height * 0.68);
    await window.mouse.up();
    await waitForScrollToSettle(window);

    expect(await minimapCenterError(window, 0.68)).toBeLessThanOrEqual(2);
    expect(await minimapScrollError(window, 0.68)).toBeLessThanOrEqual(2);
  });

  test("keeps the minimum-size thumb inside both track boundaries", async () => {
    await clickMinimapAt(window, 0.001);
    await waitForScrollToSettle(window);
    let geometry = await minimapGeometry(window);
    expect(geometry.scrollTop).toBeLessThanOrEqual(1);
    expect(geometry.thumbHeight).toBeCloseTo(14);
    expect(geometry.naturalThumbHeight).toBeLessThan(14);
    expect(geometry.thumbTop).toBeGreaterThanOrEqual(geometry.trackTop - 1);

    await clickMinimapAt(window, 0.999);
    await waitForScrollToSettle(window);
    geometry = await minimapGeometry(window);
    expect(Math.abs(geometry.scrollTop - geometry.maxScroll)).toBeLessThanOrEqual(1);
    expect(geometry.thumbBottom).toBeLessThanOrEqual(geometry.trackBottom + 1);
  });

  test("keeps split panes synchronized when the minimap jumps", async () => {
    await window.getByRole("button", { name: "Split layout" }).click();
    await expect(window.locator(".dv-split")).toBeVisible();
    await clickMinimapAt(window, 0.6);
    await waitForScrollToSettle(window);

    expect(await minimapCenterError(window, 0.6)).toBeLessThanOrEqual(2);
    expect(await minimapScrollError(window, 0.6)).toBeLessThanOrEqual(2);
    await expect.poll(async () => Math.abs(
      await window.locator(".dv-split-old .cm-scroller").evaluate((element) => element.scrollTop) -
      await window.locator(".dv-split-new .cm-scroller").evaluate((element) => element.scrollTop),
    )).toBeLessThanOrEqual(1);
  });
});

function minimapFixture(changed: boolean, marker: string): string {
  return Array.from({ length: 2_500 }, (_, index) => {
    const content = index >= 800 && index < 900 ? "\t".repeat(1_000) : "x".repeat(30);
    const value = changed && index === 250 ? "changed" : "original";
    return `line ${index + 1} ${value} ${index === 250 ? marker : ""} ${content}`;
  }).join("\n") + "\n";
}

async function clickMinimapAt(window: Page, fraction: number): Promise<void> {
  const box = await window.locator(".dv-minimap").boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.click(
    box!.x + box!.width / 2,
    box!.y + box!.height * fraction,
  );
}

async function minimapCenterError(window: Page, fraction: number): Promise<number> {
  return window.locator(".dv-minimap").evaluate((minimap, targetFraction) => {
    const thumb = minimap.querySelector<HTMLElement>(".dv-mm-thumb");
    if (!thumb) return Number.POSITIVE_INFINITY;
    const minimapBox = minimap.getBoundingClientRect();
    const thumbBox = thumb.getBoundingClientRect();
    const target = minimapBox.top + minimapBox.height * targetFraction;
    return Math.abs(thumbBox.top + thumbBox.height / 2 - target);
  }, fraction);
}

async function minimapScrollError(window: Page, fraction: number): Promise<number> {
  return window.locator(".dv-minimap").evaluate((minimap, targetFraction) => {
    const scrollers = Array.from(document.querySelectorAll<HTMLElement>(".dv-body .cm-scroller"))
      .filter((element) => element.offsetParent !== null);
    const scroller = scrollers[scrollers.length - 1];
    const trackHeight = minimap.getBoundingClientRect().height;
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(14, trackHeight * scroller.clientHeight / scroller.scrollHeight),
    );
    const thumbTravel = trackHeight - thumbHeight;
    const thumbTop = Math.max(
      0,
      Math.min(thumbTravel, targetFraction * trackHeight - thumbHeight / 2),
    );
    const expectedScrollTop = thumbTravel > 0
      ? thumbTop / thumbTravel * (scroller.scrollHeight - scroller.clientHeight)
      : 0;
    return Math.abs(scroller.scrollTop - expectedScrollTop);
  }, fraction);
}

async function minimapGeometry(window: Page): Promise<{
  scrollTop: number;
  maxScroll: number;
  trackTop: number;
  trackBottom: number;
  thumbTop: number;
  thumbBottom: number;
  thumbHeight: number;
  naturalThumbHeight: number;
}> {
  return window.locator(".dv-minimap").evaluate((minimap) => {
    const thumb = minimap.querySelector<HTMLElement>(".dv-mm-thumb")!;
    const scroller = document.querySelector<HTMLElement>(".dv-body .cm-scroller")!;
    const minimapBox = minimap.getBoundingClientRect();
    const thumbBox = thumb.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      maxScroll: scroller.scrollHeight - scroller.clientHeight,
      trackTop: minimapBox.top,
      trackBottom: minimapBox.bottom,
      thumbTop: thumbBox.top,
      thumbBottom: thumbBox.bottom,
      thumbHeight: thumbBox.height,
      naturalThumbHeight: minimapBox.height * scroller.clientHeight / scroller.scrollHeight,
    };
  });
}

async function resizeWindow(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setSize(size.width, size.height);
  }, { width, height });
}

async function waitForScrollToSettle(window: Page): Promise<void> {
  await window.locator(".dv-body .cm-scroller:visible").last().evaluate((element) => {
    return new Promise<void>((resolve) => {
      const scroller = element as HTMLElement;
      let previousHeight = -1;
      let previousTop = -1;
      let stableFrames = 0;
      const sample = () => {
        if (
          scroller.scrollHeight === previousHeight &&
          Math.abs(scroller.scrollTop - previousTop) < 0.5
        ) {
          stableFrames++;
        } else {
          stableFrames = 0;
          previousHeight = scroller.scrollHeight;
          previousTop = scroller.scrollTop;
        }
        if (stableFrames >= 6) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
}
