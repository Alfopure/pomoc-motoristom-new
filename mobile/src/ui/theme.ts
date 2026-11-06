// Shared by presentation primitives; no component imports or business state.
import { palette, type as typography } from "../design/tokens";

export const colors = {
  brand: palette.brand, ink: palette.label, muted: palette.secondaryLabel, border: "#E3E3E8",
  background: palette.background, surfaceMuted: "#E9E9EE", white: palette.card,
  danger: palette.redText, success: palette.greenText, notice: "#FFF9DA", noticeBorder: "#F2DE8A",
};
export const TAB_BAR_HEIGHT = 72;
export const NAVIGATION_CONTENT_BOTTOM = 124;
/** The floating bar sits just above the home indicator. */
export function tabBarBottom(bottomInset: number): number { return Math.max(10, bottomInset - 6); }
/** Six equal targets fit a 320-point portrait screen; landscape respects both insets. */
export function tabBarWidth(windowWidth: number, leftInset: number, rightInset: number): number {
  return Math.min(560, windowWidth - 24 - leftInset - rightInset);
}
/** Large system text uses wider cells rather than chopping labels into fragments. */
export function tabBarLayout(fontScale: number, itemCount = 6) {
  const scale = Math.min(Math.max(fontScale, 1), 2);
  const rows: 1 | 2 = fontScale > 1.1 && itemCount > 3 ? 2 : 1;
  const columns = Math.ceil(itemCount / rows);
  // 30 icon + 2 gap + 2 vertical item padding, followed by two scaled label lines.
  const rowHeight = Math.max(62, 34 + Math.ceil(typography.tabLabel.lineHeight * scale * 2));
  return { rows, columns, rowHeight, height: 10 + rows * rowHeight };
}
export function tabBarHeight(fontScale: number, itemCount = 6): number { return tabBarLayout(fontScale, itemCount).height; }
export function navigationContentBottom(fontScale: number, bottomInset: number, itemCount = 6): number {
  return Math.max(NAVIGATION_CONTENT_BOTTOM, tabBarBottom(bottomInset) + tabBarHeight(fontScale, itemCount) + 22);
}
