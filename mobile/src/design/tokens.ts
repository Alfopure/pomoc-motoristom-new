import type { TextStyle } from "react-native";

/** Compact light-mode tokens from docs/mobile/design-standard.md. Screens use
 * these values instead of their own colors, font sizes or spacing. */
export const palette = {
  background: "#F2F2F7", card: "#FFFFFF",
  label: "#17181C", secondaryLabel: "#62636B", tertiaryLabel: "#707078",
  separator: "rgba(60,60,67,0.16)", fill: "rgba(118,118,128,0.12)", fillStrong: "rgba(118,118,128,0.2)",
  brand: "#FCD703", brandSoft: "#FFF6BF", brandInk: "#7D6300",
  red: "#FF383C", redText: "#C4161B", redSoft: "#FFE7E6",
  orange: "#FF8D28", orangeText: "#934A00", orangeSoft: "#FFF0E0",
  green: "#34C759", greenText: "#196F31", greenSoft: "#E3F7E8",
  blue: "#0088FF", blueText: "#0060B8", blueSoft: "#E2F0FF",
  purple: "#AF52DE", purpleText: "#7B2FA6", purpleSoft: "#F4E7FB",
} as const;

function textStyles<T extends Record<string, TextStyle>>(value: T): T { return value; }

/** System typography scales with the user's text size; layouts adapt with it. */
export const type = textStyles({
  title: { fontSize: 32, lineHeight: 38, fontWeight: "700", letterSpacing: -0.7 },
  objectTitle: { fontSize: 24, lineHeight: 30, fontWeight: "700", letterSpacing: -0.4 },
  number: { fontSize: 30, lineHeight: 36, fontWeight: "700", letterSpacing: -0.6, fontVariant: ["tabular-nums"] },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  rowTitle: { fontSize: 16, lineHeight: 22, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 23 },
  subhead: { fontSize: 14, lineHeight: 20 },
  section: { fontSize: 15, lineHeight: 21, fontWeight: "700" },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  tag: { fontSize: 12, lineHeight: 16, fontWeight: "700" },
  tabLabel: { fontSize: 11, lineHeight: 14, fontWeight: "600" },
});

export const space = { xxs: 2, xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;
export const radius = { s: 8, m: 12, l: 20, xl: 26 } as const;
/** Smallest touch target; rows and controls never go below it. */
export const MIN_TOUCH = 44;
/** Keep dense operational content readable on tablets and wide web previews. */
export const CONTENT_MAX_WIDTH = 960;
