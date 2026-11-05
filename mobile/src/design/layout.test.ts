import { describe, expect, it } from "vitest";
import { columnsForWidth, gridItemWidth } from "./layout";
import { palette } from "./tokens";

describe("readable adaptive layouts", () => {
  it("reduces columns for narrow screens and larger system text", () => {
    expect(columnsForWidth(288, 1, 136, 3)).toBe(2);
    expect(columnsForWidth(358, 1, 136, 3)).toBe(2);
    expect(columnsForWidth(736, 1, 136, 3)).toBe(3);
    expect(columnsForWidth(288, 1.5, 136, 3)).toBe(1);
    expect(columnsForWidth(358, 2, 136, 3)).toBe(1);
    expect(columnsForWidth(736, 2, 136, 3)).toBe(2);
  });
  it("fits exact item widths including gaps without overflowing the container", () => {
    for (const width of [288, 358, 736]) {
      const columns = columnsForWidth(width, 1, 136, 3);
      expect(gridItemWidth(width, columns) * columns + (columns - 1) * 8).toBeCloseTo(width);
    }
  });
});

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
describe("small-text contrast in the light design system", () => {
  it.each([
    ["secondary labels", palette.secondaryLabel, palette.card],
    ["empty values and placeholders", palette.tertiaryLabel, palette.card],
    ["yellow state", palette.brandInk, palette.brandSoft],
    ["red state", palette.redText, palette.redSoft],
    ["orange state", palette.orangeText, palette.orangeSoft],
    ["green state", palette.greenText, palette.greenSoft],
    ["blue state", palette.blueText, palette.blueSoft],
    ["purple state", palette.purpleText, palette.purpleSoft],
    ["badge", palette.card, palette.redText],
  ])("keeps %s at WCAG AA text contrast", (_label, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
