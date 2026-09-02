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
    await fs.writeFile(
      path.join(repoDir, "minimap-interrupt.cpp"),
      minimapFixture(false, "interrupt-target-marker"),
    );
    await fs.writeFile(
      path.join(repoDir, "minimap-touch.cpp"),
      minimapFixture(false, "touch-target-marker"),
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
    await fs.writeFile(
      path.join(repoDir, "minimap-interrupt.cpp"),
      minimapFixture(true, "interrupt-target-marker"),
    );
    await fs.writeFile(
      path.join(repoDir, "minimap-touch.cpp"),
      minimapFixture(true, "touch-target-marker"),
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
    await waitForScrollToSettle(window);
    const initialScrollHeight = await activeScrollerScrollHeight(window);
    const initialMarkerTop = await firstAddMarkerFraction(window);
    await startPaintCapture(window, 0.4);
    await clickMinimapAt(window, 0.4);
    await waitForScrollToSettle(window);

    const paintErrors = await stopPaintCapture(window);
    const settledScrollHeight = await activeScrollerScrollHeight(window);
    const settledMarkerTop = await firstAddMarkerFraction(window);
    expect(Math.abs(settledScrollHeight - initialScrollHeight)).toBeGreaterThan(100);
    expect(paintErrors.logical).toBeLessThanOrEqual(2);
    expect(paintErrors.rendered).toBeLessThanOrEqual(2);
    expect(paintErrors.blankViewport).toBe(false);
    expect(await minimapCenterError(window, 0.4)).toBeLessThanOrEqual(2);
    expect(await minimapScrollError(window, 0.4)).toBeLessThanOrEqual(2);
    expect(Math.abs(settledMarkerTop - initialMarkerTop)).toBeGreaterThan(0.0001);
  });

  test("keeps a dragged destination aligned", async () => {
    await resizeWindow(app, 1_200, 800);
    await window.locator(".file-row", { hasText: "minimap-drag.cpp" }).click();
    await expect(window.locator(".dv-editor-unified .cm-content")).toContainText("drag-target-marker");
    await expect(window.locator(".dv-minimap")).toBeVisible();
    await resizeWindow(app, 900, 560);
    await waitForScrollToSettle(window);
    const initialScrollHeight = await activeScrollerScrollHeight(window);
    const minimap = window.locator(".dv-minimap");
    const box = await minimap.boundingBox();
    const thumbBox = await window.locator(".dv-mm-thumb").boundingBox();
    expect(box).not.toBeNull();
    expect(thumbBox).not.toBeNull();
    const x = box!.x + box!.width / 2;

    await window.mouse.move(x, thumbBox!.y + thumbBox!.height / 2);
    await window.mouse.down();
    await waitForScrollToSettle(window);
    await startPaintCapture(window, 0.68);
    await window.mouse.move(x, box!.y + box!.height * 0.68);
    await window.mouse.up();
    await waitForScrollToSettle(window);

    const paintErrors = await stopPaintCapture(window);
    expect(Math.abs(
      await activeScrollerScrollHeight(window) - initialScrollHeight,
    )).toBeGreaterThan(100);
    expect(paintErrors.logical).toBeLessThanOrEqual(2);
    expect(paintErrors.rendered).toBeLessThanOrEqual(2);
    expect(paintErrors.blankViewport).toBe(false);
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

  test("does not hijack later editor scrolling after a no-op click", async () => {
    await clickMinimapAt(window, 0.999);
    await waitForScrollToSettle(window);
    const scroller = window.locator(".dv-editor-unified .cm-scroller");
    const expected = await scroller.evaluate((element) => {
      const target = element.scrollHeight - element.clientHeight - 100;
      element.scrollTop = target;
      return target;
    });

    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(expected);
  });

  test("yields an active minimap jump to immediate user scrolling", async () => {
    await resizeWindow(app, 1_200, 800);
    await window.locator(".file-row", { hasText: "minimap-interrupt.cpp" }).click();
    await expect(window.locator(".dv-editor-unified .cm-content"))
      .toContainText("interrupt-target-marker");
    await resizeWindow(app, 900, 560);
    await waitForScrollToSettle(window);
    const minimapBox = await window.locator(".dv-minimap").boundingBox();
    expect(minimapBox).not.toBeNull();
    await window.mouse.move(
      minimapBox!.x + minimapBox!.width / 2,
      minimapBox!.y + minimapBox!.height * 0.45,
    );
    await window.mouse.down();

    const scroller = window.locator(".dv-editor-unified .cm-scroller");
    const expected = await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
      const target = Math.min(
        element.scrollHeight - element.clientHeight,
        element.scrollTop + 4_000,
      );
      element.scrollTop = target;
      return target;
    });
    await window.mouse.up();
    await waitForScrollToSettle(window);

    expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(expected);
  });

  test("keeps touch event ordering from cancelling a minimap jump", async () => {
    await resizeWindow(app, 1_200, 800);
    await window.locator(".file-row", { hasText: "minimap-touch.cpp" }).click();
    await expect(window.locator(".dv-editor-unified .cm-content"))
      .toContainText("touch-target-marker");
    await resizeWindow(app, 900, 560);
    await waitForScrollToSettle(window);
    const initialScrollHeight = await activeScrollerScrollHeight(window);
    const minimap = window.locator(".dv-minimap");
    const minimapBox = await minimap.boundingBox();
    expect(minimapBox).not.toBeNull();
    await window.mouse.move(
      minimapBox!.x + minimapBox!.width / 2,
      minimapBox!.y + minimapBox!.height * 0.4,
    );
    await window.mouse.down();
    await minimap.dispatchEvent("touchstart");
    await window.mouse.up();
    await waitForScrollToSettle(window);

    expect(Math.abs(
      await activeScrollerScrollHeight(window) - initialScrollHeight,
    )).toBeGreaterThan(100);
    expect(await minimapCenterError(window, 0.4)).toBeLessThanOrEqual(2);
    expect(await minimapScrollError(window, 0.4)).toBeLessThanOrEqual(2);
  });

  test("keeps split panes synchronized when the minimap jumps", async () => {
    await window.getByRole("button", { name: "Split layout" }).click();
    await expect(window.locator(".dv-split")).toBeVisible();
    await waitForScrollToSettle(window);
    await startSplitSyncCapture(window);
    await clickMinimapAt(window, 0.6);
    await waitForScrollToSettle(window);

    expect(await stopSplitSyncCapture(window)).toBeLessThanOrEqual(1);
    expect(await minimapCenterError(window, 0.6)).toBeLessThanOrEqual(2);
    expect(await minimapScrollError(window, 0.6)).toBeLessThanOrEqual(2);
    await expect.poll(async () => Math.abs(
      await window.locator(".dv-split-old .cm-scroller").evaluate((element) => element.scrollTop) -
      await window.locator(".dv-split-new .cm-scroller").evaluate((element) => element.scrollTop),
    )).toBeLessThanOrEqual(1);

    const minimapBox = await window.locator(".dv-minimap").boundingBox();
    expect(minimapBox).not.toBeNull();
    await window.mouse.move(
      minimapBox!.x + minimapBox!.width / 2,
      minimapBox!.y + minimapBox!.height * 0.45,
    );
    await window.mouse.down();
    const oldScroller = window.locator(".dv-split-old .cm-scroller");
    const expected = await oldScroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
      const target = Math.min(
        element.scrollHeight - element.clientHeight,
        element.scrollTop + 1_000,
      );
      element.scrollTop = target;
      return target;
    });
    await window.mouse.up();
    await waitForScrollToSettle(window);
    expect(await oldScroller.evaluate((element) => element.scrollTop)).toBeCloseTo(expected);
    expect(await window.locator(".dv-split-new .cm-scroller")
      .evaluate((element) => element.scrollTop)).toBeCloseTo(expected);
  });
});

function minimapFixture(changed: boolean, marker: string): string {
  return Array.from({ length: 2_500 }, (_, index) => {
    const content = index >= 800 && index < 900 ? "\t".repeat(1_000) : "x".repeat(30);
    const value = changed && (index === 250 || index === 850) ? "changed" : "original";
    const lineMarker = index === 250 ? marker : index === 850 ? "wrapped-change-marker" : "";
    return `line ${index + 1} ${value} ${lineMarker} ${content}`;
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

async function startPaintCapture(window: Page, fraction: number): Promise<void> {
  await window.evaluate((targetFraction) => {
    const captureWindow = window as Window & {
      diffMinimapPaintCapture: {
        active: boolean;
        logical: number;
        rendered: number;
        scrolled: boolean;
        blankViewport: boolean;
      };
    };
    const minimap = document.querySelector<HTMLElement>(".dv-minimap")!;
    const scroller = document.querySelector<HTMLElement>(".dv-editor-unified .cm-scroller")!;
    captureWindow.diffMinimapPaintCapture = {
      active: true,
      logical: 0,
      rendered: 0,
      scrolled: false,
      blankViewport: false,
    };
    scroller.addEventListener("scroll", () => {
      captureWindow.diffMinimapPaintCapture.scrolled = true;
    }, { once: true, passive: true });

    const scheduleSample = () => requestAnimationFrame(() => setTimeout(sample, 0));
    const sample = () => {
      const capture = captureWindow.diffMinimapPaintCapture;
      if (!capture.active) return;
      if (!capture.scrolled) {
        scheduleSample();
        return;
      }
      const minimapBox = minimap.getBoundingClientRect();
      const thumbBox = minimap.querySelector<HTMLElement>(".dv-mm-thumb")!.getBoundingClientRect();
      const trackHeight = minimapBox.height;
      const thumbHeight = Math.min(
        trackHeight,
        Math.max(14, trackHeight * scroller.clientHeight / scroller.scrollHeight),
      );
      const thumbTravel = trackHeight - thumbHeight;
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      const progress = maxScroll > 0 ? scroller.scrollTop / maxScroll : 0;
      const thumbCenter = progress * thumbTravel + thumbHeight / 2;
      const target = targetFraction * trackHeight;
      capture.logical = Math.max(capture.logical, Math.abs(thumbCenter - target));
      capture.rendered = Math.max(
        capture.rendered,
        Math.abs(thumbBox.top + thumbBox.height / 2 - minimapBox.top - target),
      );
      const scrollerBox = scroller.getBoundingClientRect();
      const viewportCenter = scrollerBox.top + scrollerBox.height / 2;
      const hasCenteredLine = Array.from(
        scroller.querySelectorAll<HTMLElement>(".cm-line"),
      ).some((line) => {
        const lineBox = line.getBoundingClientRect();
        return lineBox.top <= viewportCenter && lineBox.bottom >= viewportCenter;
      });
      if (!hasCenteredLine) capture.blankViewport = true;
      scheduleSample();
    };
    scheduleSample();
  }, fraction);
}

async function stopPaintCapture(window: Page): Promise<{
  logical: number;
  rendered: number;
  blankViewport: boolean;
}> {
  return window.evaluate(() => {
    const captureWindow = window as Window & {
      diffMinimapPaintCapture: {
        active: boolean;
        logical: number;
        rendered: number;
        blankViewport: boolean;
      };
    };
    captureWindow.diffMinimapPaintCapture.active = false;
    return {
      logical: captureWindow.diffMinimapPaintCapture.logical,
      rendered: captureWindow.diffMinimapPaintCapture.rendered,
      blankViewport: captureWindow.diffMinimapPaintCapture.blankViewport,
    };
  });
}

async function startSplitSyncCapture(window: Page): Promise<void> {
  await window.evaluate(() => {
    const captureWindow = window as Window & {
      diffMinimapSplitCapture: { active: boolean; maxDifference: number; scrolled: boolean };
    };
    const oldScroller = document.querySelector<HTMLElement>(".dv-split-old .cm-scroller")!;
    const newScroller = document.querySelector<HTMLElement>(".dv-split-new .cm-scroller")!;
    captureWindow.diffMinimapSplitCapture = { active: true, maxDifference: 0, scrolled: false };
    newScroller.addEventListener("scroll", () => {
      captureWindow.diffMinimapSplitCapture.scrolled = true;
    }, { once: true, passive: true });

    const scheduleSample = () => requestAnimationFrame(() => setTimeout(sample, 0));
    const sample = () => {
      const capture = captureWindow.diffMinimapSplitCapture;
      if (!capture.active) return;
      if (capture.scrolled) {
        capture.maxDifference = Math.max(
          capture.maxDifference,
          Math.abs(oldScroller.scrollTop - newScroller.scrollTop),
        );
      }
      scheduleSample();
    };
    scheduleSample();
  });
}

async function stopSplitSyncCapture(window: Page): Promise<number> {
  return window.evaluate(() => {
    const captureWindow = window as Window & {
      diffMinimapSplitCapture: { active: boolean; maxDifference: number };
    };
    captureWindow.diffMinimapSplitCapture.active = false;
    return captureWindow.diffMinimapSplitCapture.maxDifference;
  });
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

async function activeScrollerScrollHeight(window: Page): Promise<number> {
  return window.locator(".dv-body .cm-scroller:visible").last()
    .evaluate((element) => element.scrollHeight);
}

async function firstAddMarkerFraction(window: Page): Promise<number> {
  return window.locator(".dv-minimap .dv-mm-mark.add").first()
    .evaluate((marker) => parseFloat((marker as HTMLElement).style.top) / 100);
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
