import { describe, expect, it, vi } from "vitest";
import { loadSurface, surfaceKind } from "./glass-capabilities";
import { navigationContentBottom, tabBarBottom, tabBarHeight, tabBarLayout, tabBarWidth } from "./theme";

const allowed = { reduceTransparency: false, reduceMotion: false };
describe("optional native presentation boundary", () => {
  it("never loads view packages absent from the binary", async () => {
    const loaders = { glass: vi.fn(), blur: vi.fn() };
    expect(await loadSurface(surfaceKind("ios", allowed, null, false), loaders)).toBeNull();
    expect(loaders.glass).not.toHaveBeenCalled(); expect(loaders.blur).not.toHaveBeenCalled();
  });
  it("requires both native API and design availability and selects older-iOS blur", () => {
    expect(surfaceKind("ios", allowed, { isLiquidGlassAvailable: true, isGlassEffectAPIAvailable: true }, true)).toBe("glass");
    for (const module of [null, {}, { isLiquidGlassAvailable: true }, { isGlassEffectAPIAvailable: true }]) expect(surfaceKind("ios", allowed, module, true)).toBe("blur");
  });
  it("honors Reduce Transparency even on a glass-capable iPhone and never chooses native effects on web/Android", () => {
    const native = { isLiquidGlassAvailable: true, isGlassEffectAPIAvailable: true };
    expect(surfaceKind("ios", { ...allowed, reduceTransparency: true }, native, true)).toBe("solid");
    for (const platform of ["web", "android"]) expect(surfaceKind(platform, allowed, native, true)).toBe("solid");
  });
  it("loads only the selected supported package and degrades an unavailable decorative renderer to solid", async () => {
    const loaders = { glass: vi.fn(async () => "native glass"), blur: vi.fn(async () => "native blur") };
    expect(await loadSurface("glass", loaders)).toBe("native glass"); expect(loaders.blur).not.toHaveBeenCalled();
    loaders.blur.mockRejectedValueOnce(new Error("native view unavailable"));
    expect(await loadSurface("blur", loaders)).toBeNull();
  });
  it("keeps all six actual tab targets at least 44 points wide on supported narrow screens", () => {
    for (const width of [320, 390, 768]) {
      const bar = tabBarWidth(width, 0, 0);
      expect((bar - 2 - 8) / 6).toBeGreaterThanOrEqual(44);
      expect(bar).toBeLessThanOrEqual(width - 24);
    }
    expect(tabBarWidth(844, 47, 47)).toBeLessThanOrEqual(844 - 24 - 47 * 2);
  });
  it("uses wider two-row cells for larger text without expanding a three-item field bar", () => {
    expect(tabBarLayout(1, 6)).toMatchObject({ rows: 1, columns: 6, height: 72 });
    expect(tabBarLayout(1.1, 6).rows).toBe(1);
    expect(tabBarLayout(1.2, 6).rows).toBe(2);
    expect(tabBarLayout(2, 6)).toEqual({ rows: 2, columns: 3, rowHeight: 90, height: 190 });
    expect(tabBarLayout(2, 3)).toEqual({ rows: 1, columns: 3, rowHeight: 90, height: 100 });
    expect(tabBarLayout(2, 5)).toMatchObject({ rows: 2, columns: 3, height: 190 });
  });
  it("fits two scaled label lines in each row and keeps final content clear for the actual item count", () => {
    for (const scale of [1, 1.1, 1.2, 1.5, 2]) {
      for (const count of [3, 4, 5, 6]) {
        const layout = tabBarLayout(scale, count);
        expect(layout.rowHeight - 2).toBeGreaterThanOrEqual(30 + 2 + 14 * scale * 2);
        expect(tabBarHeight(scale, count)).toBe(10 + layout.rows * layout.rowHeight);
        for (const inset of [0, 34, 50]) {
          expect(navigationContentBottom(scale, inset, count)).toBeGreaterThanOrEqual(tabBarBottom(inset) + tabBarHeight(scale, count) + 22);
        }
      }
    }
    expect(navigationContentBottom(2, 34, 3)).toBeLessThan(navigationContentBottom(2, 34, 6));
  });
  it("reserves overlay clearance as text and safe-area grow", () => {
    expect(navigationContentBottom(1, 0)).toBeGreaterThanOrEqual(124);
    expect(navigationContentBottom(2, 34)).toBeGreaterThanOrEqual(34 - 6 + tabBarHeight(2) + 22);
    expect(navigationContentBottom(3, 50)).toBeGreaterThan(navigationContentBottom(2, 34));
    expect(tabBarHeight(1)).toBe(72);
    expect(tabBarHeight(2)).toBeGreaterThan(tabBarHeight(1.3));
    expect(tabBarHeight(4)).toBe(tabBarHeight(2));
    expect(tabBarBottom(0)).toBe(10);
  });
});
