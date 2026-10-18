import { describe, expect, it, vi } from "vitest";
import { loadSurface, surfaceKind } from "./glass-capabilities";
import { navigationContentBottom, tabBarBottom, tabBarHeight } from "./theme";

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
  it("reserves overlay clearance as text and safe-area grow", () => {
    expect(navigationContentBottom(1, 0)).toBeGreaterThanOrEqual(112);
    expect(navigationContentBottom(2, 34)).toBeGreaterThanOrEqual(34 - 6 + 62 + 9 + 22);
    expect(navigationContentBottom(3, 50)).toBeGreaterThan(navigationContentBottom(2, 34));
    expect(tabBarHeight(1)).toBe(62);
    expect(tabBarHeight(4)).toBe(tabBarHeight(1.3));
    expect(tabBarBottom(0)).toBe(10);
  });
});
