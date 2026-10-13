import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ClipboardList, FolderOpen, History, Phone, UserRound, type LucideIcon } from "lucide-react-native";
import { GlassSurface } from "./glass";
import { colors } from "./theme";

export type DispatchTab = "console" | "history" | "cases" | "tasks" | "account";
const tabs: { id: DispatchTab; label: string; accessibilityLabel: string; icon: LucideIcon }[] = [
  { id: "console", label: "Ústredňa", accessibilityLabel: "Ústredňa", icon: Phone },
  { id: "history", label: "História", accessibilityLabel: "História", icon: History },
  { id: "cases", label: "Prípady", accessibilityLabel: "Prípady", icon: FolderOpen },
  { id: "tasks", label: "Úlohy", accessibilityLabel: "Moje úlohy", icon: ClipboardList },
  { id: "account", label: "Účet", accessibilityLabel: "Účet", icon: UserRound },
];
export function GlassTabBar({ selected, onSelect }: { selected: DispatchTab; onSelect: (tab: DispatchTab) => void }) {
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const [keyboard, setKeyboard] = useState(() => Platform.OS !== "web" && Keyboard.isVisible());
  const scroll = useRef<ScrollView>(null);
  const available = width - insets.left - insets.right - 28 - 12;
  const tabWidth = Math.max(58 * Math.max(fontScale, 1), available / tabs.length);
  const selectedIndex = tabs.findIndex(tab => tab.id === selected);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboard(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false));
    const willShow = Platform.OS === "ios" ? Keyboard.addListener("keyboardWillShow", () => setKeyboard(true)) : null;
    return () => { shown.remove(); hidden.remove(); willShow?.remove(); };
  }, []);
  useEffect(() => { scroll.current?.scrollTo({ x: Math.max(0, selectedIndex * tabWidth - (available - tabWidth) / 2), animated: false }); }, [selectedIndex, tabWidth, available, keyboard]);
  if (keyboard) return null;
  return <View pointerEvents="box-none" style={[s.position, { bottom: Math.max(insets.bottom, 10) + 8 }]}>
    <View style={s.shadow}>
      <GlassSurface style={s.capsule} interactive>
        <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" contentContainerStyle={s.tabs}>
          {tabs.map(tab => <Pressable key={tab.id} accessibilityRole="tab" accessibilityLabel={tab.accessibilityLabel} accessibilityState={{ selected: selected === tab.id }} aria-selected={selected === tab.id}
            onPress={() => onSelect(tab.id)} style={({ pressed }) => [s.tab, { width: tabWidth }, selected === tab.id && s.selected, pressed && s.pressed]}>
            <tab.icon size={23} strokeWidth={selected === tab.id ? 2.3 : 1.8} color={selected === tab.id ? colors.ink : colors.muted} />
            <Text style={[s.label, selected === tab.id && s.selectedLabel]}>{tab.label}</Text>
          </Pressable>)}
        </ScrollView>
      </GlassSurface>
    </View>
  </View>;
}
const s = StyleSheet.create({
  position: { position: "absolute", left: 14, right: 14 },
  shadow: { borderRadius: 32, boxShadow: "0 8px 30px rgba(25,25,32,0.12)" },
  capsule: { padding: 5 },
  tabs: { alignItems: "stretch" },
  tab: { minHeight: 64, minWidth: 44, paddingVertical: 9, paddingHorizontal: 3, alignItems: "center", justifyContent: "center", gap: 4, borderRadius: 25 },
  selected: { backgroundColor: "#FBE57B" },
  pressed: { backgroundColor: "#EEE9D4" },
  label: { fontSize: 12, lineHeight: 18, color: colors.muted, fontWeight: "500", textAlign: "center" },
  selectedLabel: { color: colors.ink, fontWeight: "700" },
});
