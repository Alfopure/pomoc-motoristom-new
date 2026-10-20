import { Children, isValidElement, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { Check, ChevronRight, type LucideIcon } from "lucide-react-native";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import { SectionHeader } from "./list";
import { palette, radius, space, type } from "./tokens";

/** Page layout: the heading, notices and actions are inset; sections span the width. */
export const formLayout = StyleSheet.create({
  content: { paddingTop: 6, paddingBottom: NAVIGATION_CONTENT_BOTTOM },
  head: { paddingHorizontal: space.l, gap: 4 },
  notices: { paddingHorizontal: space.l, paddingTop: space.m, gap: space.m },
  actions: { paddingHorizontal: space.l, paddingTop: space.xl, gap: space.m },
});

/** Form template (docs/mobile/design-standard.md §6): grouped sections of stacked
 * label/input rows, choices as chips in a row, the main action below in yellow. */
export function FormSection({ title, footer, children }: { title?: string; footer?: string | null; children: ReactNode }) {
  const rows = Children.toArray(children);
  return <>
    {title ? <SectionHeader title={title} /> : <View style={{ height: space.l }} />}
    {/* Children.toArray keys keep their slot, so a row shown later does not remount its neighbours. */}
    <View style={s.group}>{rows.map((row, index) => <View key={isValidElement(row) && row.key !== null ? row.key : index}>{index > 0 && <View style={s.separator} />}{row}</View>)}</View>
    {footer ? <Text style={s.footer}>{footer}</Text> : null}
  </>;
}

/** Label above the input; tapping anywhere in the row focuses the input. */
export function Field({ label, action, hint, multiline, editable = true, style, accessibilityLabel, ...input }: TextInputProps & {
  label: string; action?: ReactNode; hint?: string | null;
}) {
  const ref = useRef<TextInput>(null);
  return <Pressable accessible={false} focusable={false} importantForAccessibility="no" onPress={() => { if (editable) ref.current?.focus(); }} style={s.field}>
    <View style={s.labelLine}><Text style={s.label}>{label}</Text>{action}</View>
    <TextInput ref={ref} accessibilityLabel={accessibilityLabel ?? label} accessibilityHint={input.accessibilityHint ?? hint ?? undefined} placeholderTextColor={palette.tertiaryLabel} editable={editable} multiline={multiline}
      textAlignVertical={multiline ? "top" : "center"} style={[s.input, multiline && s.multiline, !editable && { color: palette.secondaryLabel }, style]} {...input} />
    {hint ? <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={s.hint}>{hint}</Text> : null}
  </Pressable>;
}

/** Small labeled button in a field's label line, e.g. "Na mape". */
export function FieldAction({ icon: Icon, label, accessibilityLabel, onPress, disabled }: { icon: LucideIcon; label: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean }) {
  // Stays touchable while disabled: a refused tap would fall through and focus the field.
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled: Boolean(disabled) }} onPress={disabled ? undefined : onPress}
    hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }} style={({ pressed }) => [s.action, disabled && { opacity: 0.4 }, pressed && !disabled && { opacity: 0.6 }]}>
    <Icon size={13} strokeWidth={2.4} color={palette.brandInk} accessible={false} />
    <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.actionLabel}>{label}</Text>
  </Pressable>;
}

/** Label and the chosen value; opens a picker, so the value is a tap away. */
export function PickerRow({ label, value, onPress, disabled, accessibilityLabel }: { label: string; value: string; onPress: () => void; disabled?: boolean; accessibilityLabel?: string }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label + ": " + value} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.field, s.picker, pressed && { backgroundColor: "#ECECF0" }]}>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text style={s.label}>{label}</Text>
      <Text numberOfLines={1} style={[s.text, disabled && { color: palette.secondaryLabel }]}>{value}</Text></View>
    <ChevronRight size={17} strokeWidth={2.2} color={palette.tertiaryLabel} accessible={false} />
  </Pressable>;
}

/** One choice of a list; the chosen one carries a check mark. */
export function SelectRow({ label, detail, selected, onPress, disabled }: { label: string; detail?: string | null; selected: boolean; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.select, disabled && { opacity: 0.5 }, pressed && { backgroundColor: "#ECECF0" }]}>
    <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={2} style={[s.text, selected && { fontWeight: "600" }]}>{label}</Text>
      {detail ? <Text style={s.hint}>{detail}</Text> : null}</View>
    {selected ? <Check size={18} strokeWidth={2.6} color={palette.brandInk} accessible={false} /> : null}
  </Pressable>;
}

/** A label with chips (or other controls) below it. */
export function ChoiceField({ label, detail, children }: { label: string; detail?: string | null; children: ReactNode }) {
  return <View style={s.field}>
    <View style={s.labelLine}><Text style={s.label}>{label}</Text>{detail ? <Text numberOfLines={1} style={s.detail}>{detail}</Text> : null}</View>
    <View style={s.choices}>{children}</View>
  </View>;
}

/** Plain text inside a section, e.g. a confirmation or a comparison. */
export function FormText({ children, tone }: { children: ReactNode; tone?: "muted" | "danger" }) {
  return <View style={s.textRow}><Text style={[s.text, tone === "muted" && { color: palette.secondaryLabel }, tone === "danger" && { color: palette.redText }]}>{children}</Text></View>;
}

const s = StyleSheet.create({
  group: { marginHorizontal: space.l, backgroundColor: palette.card, borderRadius: radius.l, overflow: "hidden" },
  separator: { position: "absolute", top: 0, left: space.m, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator, zIndex: 1 },
  footer: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 20, paddingTop: 6 },
  field: { paddingHorizontal: space.m, paddingTop: 8, paddingBottom: 9, minHeight: 56, gap: 2, backgroundColor: palette.card },
  labelLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.s, minHeight: 18 },
  label: { ...type.caption, color: palette.secondaryLabel, flexShrink: 1 },
  detail: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, flexShrink: 1, textAlign: "right" },
  input: { fontSize: 16, color: palette.label, minHeight: 26, paddingVertical: 2, paddingHorizontal: 0 },
  multiline: { minHeight: 44, lineHeight: 21 },
  hint: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel },
  action: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 28, borderRadius: 14, paddingHorizontal: 10, backgroundColor: palette.brandSoft },
  actionLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600", color: palette.brandInk },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.s, paddingTop: 6, paddingBottom: 2 },
  text: { ...type.body, color: palette.label },
  picker: { flexDirection: "row", alignItems: "center", gap: space.s },
  textRow: { paddingHorizontal: space.m, paddingVertical: 12, minHeight: 46, justifyContent: "center", backgroundColor: palette.card },
  select: { flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: space.m, paddingVertical: 8, minHeight: 46, backgroundColor: palette.card },
});
