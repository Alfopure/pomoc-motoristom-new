import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { palette, radius, space, type } from "./tokens";
import { columnsForWidth, gridItemWidth } from "./layout";

/** Detail template pieces (docs/mobile/design-standard.md §6): header, one row of
 * labeled actions, then grouped label/value rows with at most a few icon actions. */
export type TagTone = "red" | "orange" | "green" | "blue" | "gray" | "yellow";
const tagColors: Record<TagTone, [string, string]> = {
  red: [palette.redSoft, palette.redText], orange: [palette.orangeSoft, palette.orangeText], green: [palette.greenSoft, palette.greenText],
  blue: [palette.blueSoft, palette.blueText], gray: [palette.fill, "#3A3A3C"], yellow: [palette.brandSoft, palette.brandInk],
};
export function Tag({ text, tone }: { text: string; tone: TagTone }) {
  const [background, color] = tagColors[tone];
  return <Text style={[s.tag, { backgroundColor: background, color }]}>{text}</Text>;
}

export function DetailHeader({ title, subtitle, tags, meta, trailing }: { title: string; subtitle?: string | null; tags?: ReactNode; meta?: string | null; trailing?: ReactNode }) {
  return <View style={s.header}>
    <View style={{ minWidth: 0, gap: 2 }}>
      <Text accessibilityRole="header" selectable style={s.title}>{title}</Text>
      {subtitle ? <Text selectable style={s.subtitle}>{subtitle}</Text> : null}
      {tags ? <View style={s.tags}>{tags}</View> : null}
      {meta ? <Text style={s.meta}>{meta}</Text> : null}
    </View>
    {trailing}
  </View>;
}

export type DetailAction = { icon: LucideIcon; label: string; onPress: () => void; disabled?: boolean; primary?: boolean; accessibilityLabel?: string };
/** Up to four of the most frequent actions, each with a visible label. */
export function ActionBar({ actions }: { actions: DetailAction[] }) {
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(windowWidth);
  const innerWidth = Math.max(0, width - space.l * 2);
  const columns = columnsForWidth(innerWidth, fontScale, 128, Math.max(1, actions.length));
  return <View style={s.actions} onLayout={event => setWidth(event.nativeEvent.layout.width)}>{actions.map(action => <Pressable key={action.label} accessibilityRole="button" accessibilityLabel={action.accessibilityLabel ?? action.label}
    accessibilityState={{ disabled: Boolean(action.disabled) }} disabled={action.disabled} onPress={action.onPress}
    style={({ pressed }) => [s.action, { width: gridItemWidth(innerWidth, columns) }, action.primary && s.actionPrimary, action.disabled && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}>
    <action.icon size={20} strokeWidth={2.2} color={action.primary ? palette.label : palette.brandInk} accessible={false} />
    <Text style={[s.actionLabel, action.primary && { color: palette.label }]}>{action.label}</Text>
  </Pressable>)}</View>;
}

export function IconButton({ icon: Icon, label, onPress, disabled }: { icon: LucideIcon; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [s.iconButton, disabled && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}>
    <Icon size={17} strokeWidth={2.2} color={palette.label} accessible={false} />
    <Text style={s.iconLabel}>{label}</Text>
  </Pressable>;
}

/** Label above value; empty values say so instead of disappearing. */
export function InfoRow({ label, value, detail, actions, first, empty = "Nedoplnené", alwaysShowActions }: {
  label: string; value: string | null | undefined; detail?: string | null; actions?: ReactNode; first?: boolean; empty?: string;
  /** Keep actions for an empty value, e.g. a map point without an address. */
  alwaysShowActions?: boolean;
}) {
  const shown = value?.trim() ? value : null;
  return <View style={s.info}>
    {!first && <View style={s.separator} />}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text selectable style={[s.infoValue, !shown && { color: palette.tertiaryLabel }]}>{shown ?? empty}</Text>
      {detail ? <Text selectable style={s.infoDetail}>{detail}</Text> : null}
    </View>
    {(shown || alwaysShowActions) && actions ? <View style={s.infoActions}>{actions}</View> : null}
  </View>;
}

const s = StyleSheet.create({
  tag: { ...type.tag, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, overflow: "hidden", flexShrink: 1, maxWidth: "100%" },
  header: { alignItems: "stretch", gap: space.m, paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.l },
  title: { ...type.objectTitle, color: palette.label },
  subtitle: { ...type.body, color: palette.label },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  meta: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, marginTop: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.s, paddingHorizontal: space.l },
  action: { flexGrow: 1, minWidth: 0, minHeight: 64, borderRadius: radius.l, borderCurve: "continuous", backgroundColor: palette.card, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: space.s, paddingVertical: space.m },
  actionPrimary: { backgroundColor: palette.brand },
  actionLabel: { ...type.subhead, fontWeight: "600", color: palette.brandInk, textAlign: "center" },
  iconButton: { minWidth: 44, minHeight: 44, maxWidth: "100%", borderRadius: 22, backgroundColor: palette.fill, flexDirection: "row", gap: 6, paddingHorizontal: space.m, paddingVertical: space.s, alignItems: "center", justifyContent: "center" },
  iconLabel: { ...type.caption, fontWeight: "600", color: palette.label, flexShrink: 1 },
  info: { alignItems: "stretch", gap: space.s, paddingHorizontal: space.l, paddingVertical: space.m, minHeight: 56, backgroundColor: palette.card },
  separator: { position: "absolute", top: 0, left: space.m, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  infoLabel: { ...type.caption, color: palette.secondaryLabel },
  infoValue: { ...type.body, color: palette.label },
  infoDetail: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, marginTop: 1 },
  infoActions: { flexDirection: "row", flexWrap: "wrap", gap: space.s },
});
