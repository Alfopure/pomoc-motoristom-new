import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { palette, type } from "../design/tokens";
import { GlassSurface } from "../ui/glass";
import { TAB_BAR_HEIGHT, tabBarBottom, tabBarLayout, tabBarWidth } from "../ui/theme";
import { barItems, type ShellTab } from "./navigation";
import { moduleById } from "./modules";
import { AddMark, Badge, TabGlyph, tabLabel } from "./parts";
import { useKeyboardShown } from "./keyboard";

type Props = {
  tabs: ShellTab[]; selected: ShellTab | null; badges: Partial<Record<ShellTab, number>>; showAdd: boolean;
  onSelect: (tab: ShellTab) => void; onAdd: () => void;
};

/** Prehľad · the user's modules · Moduly. Every item has a visible label; the
 * selected one sits on a moving lens like the iOS 26 tab bar. */
export function DockTabBar({ tabs, selected, badges, showAdd, onSelect, onAdd }: Props) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const keyboard = useKeyboardShown();
  const [width, setWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(true);
  const [lens] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const placed = useRef(false);
  const layout = tabBarLayout(fontScale, tabs.length + (showAdd ? 1 : 0));
  const items = barItems(tabs, showAdd, layout.rows);
  const itemWidth = width > 0 ? width / layout.columns : 0;
  const index = selected ? items.indexOf(selected) : -1;
  useEffect(() => {
    let alive = true;
    let changed = false;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive && !changed) setReduceMotion(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", value => { changed = true; if (alive) setReduceMotion(value); });
    return () => { alive = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (index < 0 || itemWidth === 0) return;
    const target = { x: (index % layout.columns) * itemWidth, y: Math.floor(index / layout.columns) * layout.rowHeight };
    if (!placed.current || reduceMotion) { lens.setValue(target); placed.current = true; return; }
    const animation = Animated.spring(lens, { toValue: target, useNativeDriver: Platform.OS !== "web", speed: 18, bounciness: 5 });
    animation.start();
    return () => animation.stop();
  }, [index, itemWidth, layout.columns, layout.rowHeight, reduceMotion, lens]);
  if (keyboard) return null;
  const cell = { width: `${100 / layout.columns}%` as const, height: layout.rowHeight };
  const outerWidth = tabBarWidth(windowWidth, insets.left, insets.right);
  return <View pointerEvents="box-none" style={[s.position, { bottom: tabBarBottom(insets.bottom), width: outerWidth, alignSelf: "center" }]}>
    <View style={s.shadow}>
      <GlassSurface style={[s.capsule, { height: layout.height }]} interactive>
        <View accessibilityRole="tablist" style={s.row} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
          {itemWidth > 0 && <Animated.View pointerEvents="none" style={[s.lens, { width: itemWidth, height: layout.rowHeight, opacity: index >= 0 ? 1 : 0, transform: lens.getTranslateTransform() }]} />}
          {items.map(item => {
            if (item === null) return <View key="spacer" pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={cell} />;
            if (item === "add") return <Pressable key="add" accessibilityRole="button" accessibilityShowsLargeContentViewer accessibilityLargeContentTitle="Pridať modul do lišty" accessibilityLabel="Pridať modul do lišty" onPress={onAdd}
              style={({ pressed }) => [s.item, cell, pressed && s.pressed]}>
              <View style={s.icon}><AddMark /></View>
              <Text numberOfLines={2} maxFontSizeMultiplier={2} style={[s.label, { color: palette.tertiaryLabel }]}>Pridať</Text>
            </Pressable>;
            const on = item === selected, badge = badges[item] ?? 0;
            return <Pressable key={item} accessibilityRole="tab" accessibilityShowsLargeContentViewer accessibilityLargeContentTitle={item === "prehlad" || item === "moduly" ? tabLabel(item) : moduleById(item).name} accessibilityState={{ selected: on }} aria-selected={on}
              accessibilityLabel={(item === "prehlad" || item === "moduly" ? tabLabel(item) : moduleById(item).name) + (badge ? ", " + badge + " čaká" : "")} onPress={() => onSelect(item)}
              style={({ pressed }) => [s.item, cell, pressed && !on && s.pressed]}>
              <View style={s.icon}><TabGlyph tab={item} size={24} color={on ? palette.label : palette.secondaryLabel} />
                {badge > 0 && <View style={s.badge}><Badge count={badge} /></View>}</View>
              <Text numberOfLines={2} maxFontSizeMultiplier={2} style={[s.label, on && s.labelOn]}>{tabLabel(item)}</Text>
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
  row: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "stretch" },
  lens: { position: "absolute", top: 0, left: 0, borderRadius: 27, backgroundColor: "rgba(118,118,128,0.17)" },
  item: { flexGrow: 0, flexShrink: 0, minWidth: 0, alignItems: "center", justifyContent: "center", gap: 2, borderRadius: 27, paddingHorizontal: 0, paddingVertical: 1 },
  pressed: { backgroundColor: "rgba(118,118,128,0.1)" },
  icon: { height: 30, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: -2, left: 16 },
  label: { ...type.tabLabel, maxWidth: "100%", color: palette.secondaryLabel, textAlign: "center" },
  labelOn: { color: palette.label, fontWeight: "700" },
});
