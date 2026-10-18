import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronRight, Phone } from "lucide-react-native";
import { tabBarBottom, tabBarHeight } from "../ui/theme";
import { elapsed, type CallBarCall } from "./call-bar-model";
export { CALL_BAR_SPACE, callBarCall, type CallBarCall } from "./call-bar-model";

/** A green bar above the tab bar while a call runs on the account; one tap opens it.
 * The shell hides it with the keyboard, on Ústredňa and in that call's detail. */
export function CallBar({ call, active, onPress }: { call: CallBarCall; active: boolean; onPress: () => void }) {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const [now, setNow] = useState(Date.now);
  const timed = call.count === 1;
  useEffect(() => {
    if (!active || !timed) return;
    const tick = () => setNow(Date.now()), first = setTimeout(tick, 0), timer = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [active, timed]);
  const time = timed ? elapsed(call.startedAt, now) : "";
  const label = timed ? "Prebiehajúci hovor: " + call.title + ", " + call.status + ". Otvoriť detail hovoru" : "Prebiehajúce hovory: " + call.title + ". Otvoriť Ústredňu";
  return <View pointerEvents="box-none" style={[s.position, { bottom: tabBarBottom(insets.bottom) + tabBarHeight(fontScale) + 8, left: 12 + insets.left, right: 12 + insets.right }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [s.bar, pressed && { opacity: 0.85 }]}>
      <View style={s.icon}><Phone size={14} strokeWidth={2.6} color="#FFFFFF" accessible={false} /></View>
      <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.title}>{call.title}</Text>
      <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.status}>{time ? call.status + " · " + time : call.status}</Text>
      <ChevronRight size={16} strokeWidth={2.4} color="#FFFFFF" accessible={false} />
    </Pressable>
  </View>;
}

const s = StyleSheet.create({
  position: { position: "absolute" },
  // Dark green keeps white text above 4.5 : 1 (5.07 : 1).
  bar: { minHeight: 44, borderRadius: 22, backgroundColor: "#1D7F37", flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 8, paddingRight: 12,
    shadowColor: "#000", shadowOpacity: 0.14, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  icon: { width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  title: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, fontWeight: "600", color: "#FFFFFF" },
  status: { flexShrink: 0, fontSize: 13, lineHeight: 18, fontWeight: "500", color: "#FFFFFF", fontVariant: ["tabular-nums"] },
});
