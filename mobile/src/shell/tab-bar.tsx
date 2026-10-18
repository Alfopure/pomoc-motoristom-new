import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Keyboard, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { palette } from "../design/tokens";
import { GlassSurface } from "../ui/glass";
import { TAB_BAR_HEIGHT, tabBarBottom, tabBarHeight } from "../ui/theme";
import type { ShellTab } from "./navigation";
import { AddMark, Badge, TabGlyph, tabLabel } from "./parts";

type Props = {
  tabs: ShellTab[]; selected: ShellTab | null; badges: Partial<Record<ShellTab, number>>; showAdd: boolean;
  onSelect: (tab: ShellTab) => void; onAdd: () => void;
};
type Item = ShellTab | "add";

/** Prehľad · the user's modules · Moduly. Every item has a visible label; the
 * selected one sits on a moving lens like the iOS 26 tab bar. */
export function DockTabBar({ tabs, selected, badges, showAdd, onSelect, onAdd }: Props) {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const [keyboard, setKeyboard] = useState(() => Platform.OS !== "web" && Keyboard.isVisible());
  const [width, setWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(true);
  const [lens] = useState(() => new Animated.Value(0));
  const placed = useRef(false);
  const items: Item[] = showAdd ? [...tabs.slice(0, -1), "add", tabs[tabs.length - 1]] : tabs;
  const itemWidth = width > 0 ? width / items.length : 0;
  const index = selected ? items.indexOf(selected) : -1;
  useEffect(() => {
    if (Platform.OS === "web") return;
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboard(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false));
    const willShow = Platform.OS === "ios" ? Keyboard.addListener("keyboardWillShow", () => setKeyboard(true)) : null;
    return () => { shown.remove(); hidden.remove(); willShow?.remove(); };
  }, []);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive) setReduceMotion(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", value => setReduceMotion(value));
    return () => { alive = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (index < 0 || itemWidth === 0) return;
    const target = index * itemWidth;
    if (!placed.current || reduceMotion) { lens.setValue(target); placed.current = true; return; }
    Animated.spring(lens, { toValue: target, useNativeDriver: Platform.OS !== "web", speed: 18, bounciness: 5 }).start();
  }, [index, itemWidth, reduceMotion, lens]);
  if (keyboard) return null;
  const height = tabBarHeight(fontScale);
  return <View pointerEvents="box-none" style={[s.position, { bottom: tabBarBottom(insets.bottom), left: 12 + insets.left, right: 12 + insets.right }]}>
    <View style={s.shadow}>
      <GlassSurface style={[s.capsule, { height }]} interactive>
        <View accessibilityRole="tablist" style={s.row} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
          {itemWidth > 0 && <Animated.View pointerEvents="none" style={[s.lens, { width: itemWidth, opacity: index >= 0 ? 1 : 0, transform: [{ translateX: lens }] }]} />}
          {items.map(item => {
            if (item === "add") return <Pressable key="add" accessibilityRole="button" accessibilityLabel="Pridať modul do lišty" onPress={onAdd}
              style={({ pressed }) => [s.item, pressed && s.pressed]}>
              <View style={s.icon}><AddMark /></View>
              <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={[s.label, { color: palette.tertiaryLabel }]}>Pridať</Text>
            </Pressable>;
            const on = item === selected, badge = badges[item] ?? 0;
            return <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: on }} aria-selected={on}
              accessibilityLabel={tabLabel(item) + (badge ? ", " + badge + " čaká" : "")} onPress={() => onSelect(item)}
              style={({ pressed }) => [s.item, pressed && !on && s.pressed]}>
              <View style={s.icon}><TabGlyph tab={item} size={24} color={on ? palette.label : palette.secondaryLabel} />
                {badge > 0 && <View style={s.badge}><Badge count={badge} /></View>}</View>
              <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={[s.label, on && s.labelOn]}>{tabLabel(item)}</Text>
            </Pressable>;
          })}
        </View>
      </GlassSurface>
    </View>
  </View>;
}
const s = StyleSheet.create({
  position: { position: "absolute" },
  shadow: { borderRadius: TAB_BAR_HEIGHT / 2, boxShadow: "0 10px 30px rgba(0,0,0,0.14)" },
  capsule: { borderRadius: TAB_BAR_HEIGHT / 2, padding: 4, justifyContent: "center" },
  row: { flex: 1, flexDirection: "row", alignItems: "stretch" },
  lens: { position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 27, backgroundColor: "rgba(118,118,128,0.17)" },
  item: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center", gap: 2, borderRadius: 27, paddingHorizontal: 2 },
  pressed: { backgroundColor: "rgba(118,118,128,0.1)" },
  icon: { height: 30, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: -2, left: 16 },
  label: { fontSize: 10.5, lineHeight: 13, fontWeight: "600", color: palette.secondaryLabel },
  labelOn: { color: palette.label, fontWeight: "700" },
});
