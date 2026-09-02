import { describe, expect, it } from "vitest";
import { diffMinimapScrollGeometry, diffMinimapScrollTop } from "./DiffMinimap";

describe("diff minimap scroll geometry", () => {
  it("centers the visible thumb on an interior click", () => {
    const trackHeight = 800;
    const geometry = diffMinimapScrollGeometry(8_000, 800, trackHeight);
    const scrollTop = diffMinimapScrollTop(0.4, 8_000, 800, trackHeight);
    const progress = scrollTop / geometry.maxScroll;
    const thumbCenter = progress * geometry.thumbTravel + geometry.thumbHeight / 2;

    expect(thumbCenter).toBeCloseTo(trackHeight * 0.4);
  });

  it("includes the minimum rendered thumb height in the position", () => {
    const trackHeight = 800;
    const geometry = diffMinimapScrollGeometry(800_000, 800, trackHeight);
    const scrollTop = diffMinimapScrollTop(0.4, 800_000, 800, trackHeight);
    const progress = scrollTop / geometry.maxScroll;
    const thumbCenter = progress * geometry.thumbTravel + geometry.thumbHeight / 2;

    expect(geometry.thumbHeight).toBe(14);
    expect(thumbCenter).toBeCloseTo(trackHeight * 0.4);
  });

  it("keeps the thumb inside the track at both ends", () => {
    const geometry = diffMinimapScrollGeometry(8_000, 800, 800);

    expect(diffMinimapScrollTop(0, 8_000, 800, 800)).toBe(0);
    expect(diffMinimapScrollTop(1, 8_000, 800, 800)).toBe(geometry.maxScroll);
  });

  it("does not scroll when the entire document is visible", () => {
    expect(diffMinimapScrollTop(0.7, 600, 800, 800)).toBe(0);
  });
});
