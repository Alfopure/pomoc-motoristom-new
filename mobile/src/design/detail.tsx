import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { palette, space, type } from "./tokens";

/** Detail template pieces (docs/mobile/design-standard.md §6): header, one row of
 * labeled actions, then grouped label/value rows with at most a few icon actions. */
export type TagTone = "red" | "orange" | "green" | "blue" | "gray" | "yellow";
const tagColors: Record<TagTone, [string, string]> = {
  red: [palette.redSoft, palette.redText], orange: [palette.orangeSoft, palette.orangeText], green: [palette.greenSoft, palette.greenText],
  blue: [palette.blueSoft, palette.blueText], gray: [palette.fill, "#3A3A3C"], yellow: [palette.brandSoft, palette.brandInk],
};
export function Tag({ text, tone }: { text: string; tone: TagTone }) {
  const [background, color] = tagColors[tone];
  return <Text numberOfLines={1} style={[s.tag, { backgroundColor: background, color }]}>{text}</Text>;
}

export function DetailHeader({ title, subtitle, tags, meta, trailing }: { title: string; subtitle?: string | null; tags?: ReactNode; meta?: string | null; trailing?: ReactNode }) {
  return <View style={s.header}>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text accessibilityRole="header" selectable style={s.title}>{title}</Text>
      {subtitle ? <Text selectable numberOfLines={2} style={s.subtitle}>{subtitle}</Text> : null}
      {tags ? <View style={s.tags}>{tags}</View> : null}
      {meta ? <Text style={s.meta}>{meta}</Text> : null}
    </View>
    {trailing}
  </View>;
}

export type DetailAction = { icon: LucideIcon; label: string; onPress: () => void; disabled?: boolean; primary?: boolean; accessibilityLabel?: string };
/** Up to four of the most frequent actions, each with a visible label. */
export function ActionBar({ actions }: { actions: DetailAction[] }) {
  return <View style={s.actions}>{actions.map(action => <Pressable key={action.label} accessibilityRole="button" accessibilityLabel={action.accessibilityLabel ?? action.label}
    accessibilityState={{ disabled: Boolean(action.disabled) }} disabled={action.disabled} onPress={action.onPress}
    style={({ pressed }) => [s.action, action.primary && s.actionPrimary, action.disabled && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}>
    <action.icon size={20} strokeWidth={2.2} color={action.primary ? palette.label : palette.brandInk} accessible={false} />
    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.3} style={[s.actionLabel, action.primary && { color: palette.label }]}>{action.label}</Text>
  </Pressable>)}</View>;
}

export function IconButton({ icon: Icon, label, onPress, disabled }: { icon: LucideIcon; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [s.iconButton, disabled && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}>
    <Icon size={17} strokeWidth={2.2} color={palette.label} accessible={false} />
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
  // A tag keeps its width in a row; the text beside it shrinks instead.
  tag: { ...type.tag, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1, overflow: "hidden", flexShrink: 0, maxWidth: "100%" },
  header: { flexDirection: "row", alignItems: "flex-start", gap: space.m, paddingHorizontal: space.l, paddingTop: 2, paddingBottom: space.m },
  title: { ...type.objectTitle, color: palette.label },
  subtitle: { ...type.body, color: palette.label },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  meta: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, marginTop: 4 },
  actions: { flexDirection: "row", gap: space.s, paddingHorizontal: space.l },
  action: { flex: 1, minWidth: 0, minHeight: 58, borderRadius: 14, backgroundColor: palette.card, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 4 },
  actionPrimary: { backgroundColor: palette.brand },
  actionLabel: { fontSize: 12, lineHeight: 15, fontWeight: "600", color: palette.brandInk },
  iconButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: palette.fill, alignItems: "center", justifyContent: "center" },
  info: { flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: space.m, paddingVertical: 9, minHeight: 52, backgroundColor: palette.card },
  separator: { position: "absolute", top: 0, left: space.m, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  infoLabel: { ...type.caption, color: palette.secondaryLabel },
  infoValue: { ...type.body, color: palette.label },
  infoDetail: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, marginTop: 1 },
  infoActions: { flexDirection: "row", gap: 6 },
});
