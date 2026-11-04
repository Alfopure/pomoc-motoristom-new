import { StyleSheet, Text, View } from "react-native";
import { ChevronLeft, Star } from "lucide-react-native";
import { palette, space, type } from "../design/tokens";
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
    <View style={s.mainRow}>
      <View style={s.left}>
        {left.kind === "back"
          ? <GlassButton label={left.label} accessibilityLabel={"Späť na " + left.label} onPress={left.onPress} disabled={left.disabled}
            icon={<ChevronLeft size={20} strokeWidth={2.5} color={palette.label} accessible={false} style={{ marginLeft: -4 }} />} />
          : <GlassButton accessibilityLabel={left.accessibilityLabel ?? "Váš stav: " + left.label + ". Otvoriť ústredňu"} onPress={left.onPress} label={left.label}
            icon={<View style={[s.dot, { backgroundColor: toneColor[left.tone] }]} />} />}
      </View>
      <View style={s.account}>
        {test && <Text accessibilityLabel="Testovacie prostredie" style={s.test}>TEST</Text>}
        <GlassButton tone="brand" label="Účet" accessibilityLabel="Účet a nastavenia" onPress={onAccount}
          icon={<Text maxFontSizeMultiplier={1.5} style={s.initials}>{initials}</Text>} />
      </View>
    </View>
    {onPin && <View style={s.pin}><GlassButton accessibilityLabel="Pridať modul do spodnej lišty" label="Do lišty" onPress={onPin}
      icon={<Star size={17} strokeWidth={2.2} color={palette.label} accessible={false} />} /></View>}
  </View>;
}
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2)).toLocaleUpperCase("sk");
  return letters || "?";
}
const s = StyleSheet.create({
  bar: { gap: space.s, paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.s },
  mainRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.s },
  left: { flex: 1, minWidth: 104, alignItems: "flex-start" },
  account: { flexDirection: "row", alignItems: "center", flexShrink: 0, gap: space.s },
  pin: { alignItems: "flex-end" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  test: { ...type.tag, fontSize: 11, lineHeight: 14, letterSpacing: 0.6, color: palette.brandInk, backgroundColor: palette.brandSoft, borderRadius: 7, paddingHorizontal: 6, paddingVertical: 4, overflow: "hidden" },
  initials: { ...type.caption, fontWeight: "700", color: palette.label },
});
