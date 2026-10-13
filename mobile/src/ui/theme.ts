// Shared by presentation primitives; no component imports or business state.
export const colors = {
  brand: "#FCD703", ink: "#171719", muted: "#616168", border: "#E6E6EB",
  background: "#F5F5F7", surfaceMuted: "#EFEFF3", white: "#FFFFFF",
  danger: "#B91C1C", success: "#087F5B", notice: "#FFF9DA", noticeBorder: "#F2DE8A",
};
export const NAVIGATION_CONTENT_BOTTOM = 124;
export function navigationContentBottom(fontScale: number, bottomInset: number): number {
  return Math.max(NAVIGATION_CONTENT_BOTTOM, Math.max(bottomInset, 10) + 12 + 48 + 18 * Math.max(fontScale, 1) + 24);
}
