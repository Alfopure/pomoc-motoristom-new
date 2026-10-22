import { StyleSheet, Text, View } from "react-native";
import { ChevronLeft, Star } from "lucide-react-native";
import { palette, space } from "../design/tokens";
import { GlassButton } from "./parts";

export type PresenceTone = "green" | "orange" | "red" | "gray";
type Props = {
  left: { kind: "status"; label: string; tone: PresenceTone; onPress: () => void; accessibilityLabel?: string } | { kind: "back"; label: string; onPress: () => void; disabled?: boolean };
  onPin?: (() => void) | null; test: boolean; initials: string; onAccount: () => void;
};
const toneColor: Record<PresenceTone, string> = { green: palette.green, orange: palette.orange, red: palette.red, gray: "#AEAEB2" };

/** Left: the person's status (a dispatcher's availability, a pristavovač's position)
 * or Back. Right: add to the bar, environment and account. */
export function ShellTopBar({ left, onPin, test, initials, onAccount }: Props) {
  return <View style={s.bar}>
    {left.kind === "back"
      ? <View style={s.backWrap}><GlassButton label={left.label} accessibilityLabel={"Späť na " + left.label} onPress={left.onPress} disabled={left.disabled}
        icon={<ChevronLeft size={20} strokeWidth={2.5} color={palette.label} accessible={false} style={{ marginLeft: -4 }} />} /></View>
      : <GlassButton accessibilityLabel={left.accessibilityLabel ?? "Váš stav: " + left.label + ". Otvoriť ústredňu"} onPress={left.onPress} label={left.label}
        icon={<View style={[s.dot, { backgroundColor: toneColor[left.tone] }]} />} />}
    <View style={s.spacer} />
    {onPin && <GlassButton accessibilityLabel="Pridať modul do spodnej lišty" label="Do lišty" onPress={onPin}
      icon={<Star size={17} strokeWidth={2.2} color={palette.label} accessible={false} />} />}
    {test && <Text accessibilityLabel="Testovacie prostredie" style={s.test}>TEST</Text>}
    <GlassButton round tone="brand" accessibilityLabel="Účet a nastavenia" onPress={onAccount}
      icon={<Text maxFontSizeMultiplier={1.2} style={s.initials}>{initials}</Text>} />
  </View>;
}
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2)).toLocaleUpperCase("sk");
  return letters || "?";
}
const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: 14, paddingTop: space.xs, paddingBottom: space.xs, minHeight: 48 },
  spacer: { flex: 1 },
  backWrap: { flexShrink: 1, maxWidth: "55%" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  test: { fontSize: 10, lineHeight: 13, fontWeight: "800", letterSpacing: 0.8, color: palette.label, backgroundColor: "#FFF4AF", borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, overflow: "hidden" },
  initials: { fontSize: 12, lineHeight: 15, fontWeight: "700", color: palette.label },
});
