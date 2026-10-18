import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { palette, radius, space, type } from "./tokens";

/** Grouped rows with inset separators, as in iOS Settings. */
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.group, style]}>{children}</View>;
}
export function Row({ title, subtitle, leading, trailing, onPress, first, accessibilityLabel, tone }: {
  title: string; subtitle?: string | null; leading?: ReactNode; trailing?: ReactNode; onPress?: () => void; first?: boolean; accessibilityLabel?: string; tone?: "link" | "danger";
}) {
  const body = <>
    {!first && <View style={[s.separator, { left: leading ? 52 : space.m }]} />}
    {leading}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={2} style={[s.rowTitle, tone === "link" && { color: palette.brandInk }, tone === "danger" && { color: palette.redText }]}>{title}</Text>
      {subtitle ? <Text numberOfLines={2} style={s.rowSubtitle}>{subtitle}</Text> : null}
    </View>
    {trailing}
  </>;
  if (!onPress) return <View style={s.row}>{body}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: "#ECECF0" }]}>{body}</Pressable>;
}
export function SectionHeader({ title, detail }: { title: string; detail?: string | null }) {
  return <View style={s.sectionHeader}><Text accessibilityRole="header" style={s.sectionTitle}>{title}</Text>{detail ? <Text numberOfLines={1} style={s.sectionDetail}>{detail}</Text> : null}</View>;
}

const s = StyleSheet.create({
  group: { marginHorizontal: space.l, backgroundColor: palette.card, borderRadius: radius.l, overflow: "hidden" },
  row: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: space.m, paddingVertical: 7, backgroundColor: palette.card },
  separator: { position: "absolute", top: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  rowTitle: { ...type.rowTitle, color: palette.label },
  rowSubtitle: { ...type.subhead, color: palette.secondaryLabel },
  sectionHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.s, paddingHorizontal: 20, paddingTop: space.l, paddingBottom: 6 },
  sectionTitle: { ...type.section, color: palette.label },
  sectionDetail: { ...type.caption, color: palette.secondaryLabel, flexShrink: 1, textAlign: "right" },
});
