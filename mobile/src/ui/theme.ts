// Shared by presentation primitives; no component imports or business state.
import { palette } from "../design/tokens";

export const colors = {
  brand: palette.brand, ink: "#111113", muted: palette.secondaryLabel, border: "#E3E3E8",
  background: palette.background, surfaceMuted: "#E9E9EE", white: palette.card,
  danger: palette.redText, success: palette.greenText, notice: "#FFF9DA", noticeBorder: "#F2DE8A",
};
export const TAB_BAR_HEIGHT = 62;
export const NAVIGATION_CONTENT_BOTTOM = 112;
/** The floating bar sits just above the home indicator. */
export function tabBarBottom(bottomInset: number): number { return Math.max(10, bottomInset - 6); }
/** Labels may grow up to 1.3× with the system text size. */
export function tabBarHeight(fontScale: number): number {
  return TAB_BAR_HEIGHT + Math.round((Math.min(Math.max(fontScale, 1), 1.3) - 1) * 30);
}
export function navigationContentBottom(fontScale: number, bottomInset: number): number {
  return Math.max(NAVIGATION_CONTENT_BOTTOM, tabBarBottom(bottomInset) + tabBarHeight(fontScale) + 22);
}
