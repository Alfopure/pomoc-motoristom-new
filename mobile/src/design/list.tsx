import type { ReactNode } from "react";
import { Pressable, StyleSheet, Switch, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { palette, radius, space, type } from "./tokens";

/** Grouped rows with inset separators, as in iOS Settings. */
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.group, style]}>{children}</View>;
}
export function Row({ title, subtitle, leading, trailing, onPress, first, accessibilityLabel, tone, disabled }: {
  title: string; subtitle?: string | null; leading?: ReactNode; trailing?: ReactNode; onPress?: () => void; first?: boolean; accessibilityLabel?: string; tone?: "link" | "danger";
  /** Shown dimmed and announced as unavailable. */
  disabled?: boolean;
}) {
  const body = <>
    {!first && <View style={[s.separator, { left: leading ? 52 : space.m }]} />}
    {leading}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={[s.rowTitle, tone === "link" && { color: palette.brandInk }, tone === "danger" && { color: palette.redText }, disabled && { color: palette.tertiaryLabel }]}>{title}</Text>
      {subtitle ? <Text style={s.rowSubtitle}>{subtitle}</Text> : null}
    </View>
    {trailing}
  </>;
  if (!onPress) return <View style={s.row}>{body}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? [title, subtitle].filter(Boolean).join(". ")} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.row, pressed && !disabled && { backgroundColor: "#ECECF0" }]}>{body}</Pressable>;
}
/** A setting that is on or off. The whole row is the control, so the touch target
 * is the row and VoiceOver reads one switch with its title. */
export function SwitchRow({ title, subtitle, value, onChange, first, disabled }: {
  title: string; subtitle?: string | null; value: boolean; onChange: (on: boolean) => void; first?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="switch" accessibilityLabel={title} accessibilityHint={subtitle ?? undefined} accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
    aria-checked={value} disabled={disabled} onPress={() => onChange(!value)} style={({ pressed }) => [s.row, pressed && !disabled && { backgroundColor: "#ECECF0" }]}>
    {!first && <View style={[s.separator, { left: space.m }]} />}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={[s.rowTitle, disabled && { color: palette.tertiaryLabel }]}>{title}</Text>
      {subtitle ? <Text style={s.rowSubtitle}>{subtitle}</Text> : null}
    </View>
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Switch value={value} disabled={disabled} trackColor={{ true: palette.green, false: palette.fillStrong }} thumbColor={palette.card} ios_backgroundColor={palette.fillStrong} />
    </View>
  </Pressable>;
}
export function SectionHeader({ title, detail }: { title: string; detail?: string | null }) {
  return <View style={s.sectionHeader}><Text accessibilityRole="header" style={s.sectionTitle}>{title}</Text>{detail ? <Text style={s.sectionDetail}>{detail}</Text> : null}</View>;
}

const s = StyleSheet.create({
  group: { marginHorizontal: space.l, backgroundColor: palette.card, borderRadius: radius.l, borderCurve: "continuous", overflow: "hidden" },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.l, paddingVertical: 11, backgroundColor: palette.card },
  separator: { position: "absolute", top: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  rowTitle: { ...type.rowTitle, color: palette.label },
  rowSubtitle: { ...type.subhead, color: palette.secondaryLabel },
  sectionHeader: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: space.s, paddingHorizontal: 20, paddingTop: space.xl, paddingBottom: space.s },
  sectionTitle: { ...type.section, color: palette.label, flexShrink: 1 },
  sectionDetail: { ...type.caption, color: palette.secondaryLabel, flexShrink: 1, textAlign: "right" },
});
