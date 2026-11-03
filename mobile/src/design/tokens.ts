import type { TextStyle } from "react-native";

/** Compact light-mode tokens from docs/mobile/design-standard.md. Screens use
 * these values instead of their own colors, font sizes or spacing. */
export const palette = {
  background: "#F2F2F7", card: "#FFFFFF",
  label: "#000000", secondaryLabel: "#6C6C70", tertiaryLabel: "#AEAEB2",
  separator: "rgba(60,60,67,0.16)", fill: "rgba(118,118,128,0.12)", fillStrong: "rgba(118,118,128,0.2)",
  brand: "#FCD703", brandSoft: "#FFF6BF", brandInk: "#7D6300",
  red: "#FF383C", redText: "#C4161B", redSoft: "#FFE7E6",
  orange: "#FF8D28", orangeText: "#B35A00", orangeSoft: "#FFF0E0",
  green: "#34C759", greenText: "#1D7F37", greenSoft: "#E3F7E8",
  blue: "#0088FF", blueText: "#0060B8", blueSoft: "#E2F0FF",
  purple: "#AF52DE", purpleText: "#7B2FA6", purpleSoft: "#F4E7FB",
} as const;

function textStyles<T extends Record<string, TextStyle>>(value: T): T { return value; }

/** One step below the iOS defaults; system text size still scales them. */
export const type = textStyles({
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.5 },
  objectTitle: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.3 },
  number: { fontSize: 24, lineHeight: 29, fontWeight: "700", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 20 },
  subhead: { fontSize: 13, lineHeight: 18 },
  section: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  tag: { fontSize: 11, lineHeight: 14, fontWeight: "700" },
  tabLabel: { fontSize: 10.5, lineHeight: 13, fontWeight: "600" },
});

export const space = { xxs: 2, xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;
export const radius = { s: 8, m: 12, l: 16, xl: 22 } as const;
/** Smallest touch target; rows and controls never go below it. */
export const MIN_TOUCH = 44;
