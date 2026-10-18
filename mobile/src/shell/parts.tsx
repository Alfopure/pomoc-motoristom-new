import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ClipboardList, FolderOpen, House, LayoutGrid, Phone, Plus, Wrench, type LucideIcon } from "lucide-react-native";
import { palette, radius, space, type } from "../design/tokens";
import { GlassSurface } from "../ui/glass";
import { moduleById, type ModuleId } from "./modules";
import type { ShellTab } from "./navigation";

export const moduleIcons: Record<ModuleId, LucideIcon> = { hovory: Phone, pripady: FolderOpen, ulohy: ClipboardList, nastroje: Wrench };
export const tabLabel = (tab: ShellTab) => tab === "prehlad" ? "Prehľad" : tab === "moduly" ? "Moduly" : moduleById(tab).short;

/** Settings-style colored square used for modules in grids and lists. */
export function ModuleTile({ id, size = 28 }: { id: ModuleId; size?: number }) {
  const item = moduleById(id), Icon = moduleIcons[id];
  return <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.27), backgroundColor: item.color, alignItems: "center", justifyContent: "center" }}>
    <Icon size={Math.round(size * 0.55)} strokeWidth={2.2} color={item.ink} accessible={false} />
  </View>;
}
/** Yellow Moduly mark; the same shape in the bar, the mini bar and help texts. */
export function ModulesMark({ size = 26 }: { size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), backgroundColor: palette.brand, alignItems: "center", justifyContent: "center" }}>
    <LayoutGrid size={Math.round(size * 0.58)} strokeWidth={2.4} color={palette.label} fill={palette.label} accessible={false} />
  </View>;
}
export function TabGlyph({ tab, size, color }: { tab: ShellTab; size: number; color: string }) {
  if (tab === "moduly") return <ModulesMark size={size + 2} />;
  const Icon = tab === "prehlad" ? House : moduleIcons[tab];
  return <Icon size={size} strokeWidth={2.1} color={color} accessible={false} />;
}
export function AddMark({ size = 24, color = palette.tertiaryLabel }: { size?: number; color?: string }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1.5, borderStyle: "dashed", borderColor: color, alignItems: "center", justifyContent: "center" }}>
    <Plus size={Math.round(size * 0.5)} strokeWidth={2.6} color={color} accessible={false} />
  </View>;
}

/** Read-only miniature of the bar, so a change is visible before leaving. */
export function MiniBar({ tabs, showAdd, style }: { tabs: ShellTab[]; showAdd: boolean; style?: StyleProp<ViewStyle> }) {
  const items: (ShellTab | "add")[] = showAdd ? [...tabs.slice(0, -1), "add", tabs[tabs.length - 1]] : tabs;
  return <View accessible accessibilityLabel={"Spodná lišta: " + tabs.map(tabLabel).join(", ")} style={[s.miniBar, style]}>
    {items.map(item => <View key={item} style={s.miniItem}>
      <View style={s.miniIcon}>{item === "add" ? <AddMark size={19} /> : <TabGlyph tab={item} size={19} color="#3A3A3C" />}</View>
      <Text numberOfLines={1} maxFontSizeMultiplier={1.2} style={[s.miniLabel, item === "add" && { color: palette.tertiaryLabel }]}>{item === "add" ? "voľné" : tabLabel(item)}</Text>
    </View>)}
  </View>;
}

export function Segmented<T extends string>({ items, value, onChange, accessibilityLabel }: {
  items: { id: T; label: string; badge?: number | null }[]; value: T; onChange: (value: T) => void; accessibilityLabel: string;
}) {
  return <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={s.segment}>{items.map(item => {
    const selected = item.id === value;
    return <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={item.label + (item.badge ? ", " + item.badge : "")}
      hitSlop={{ top: 6, bottom: 6 }} onPress={() => onChange(item.id)} style={({ pressed }) => [s.segmentItem, selected && s.segmentSelected, pressed && !selected && { opacity: 0.6 }]}>
      <Text numberOfLines={1} style={[s.segmentText, selected && { color: palette.label }]}>{item.label}</Text>
      {Boolean(item.badge) && <View style={s.badge}><Text style={s.badgeText}>{item.badge! > 99 ? "99+" : item.badge}</Text></View>}
    </Pressable>;
  })}</View>;
}

/** Glass control for the top bar; text and icon stay readable in every surface. */
export function GlassButton({ label, accessibilityLabel, icon, onPress, tone = "glass", round }: {
  label?: string; accessibilityLabel: string; icon?: ReactNode; onPress: () => void; tone?: "glass" | "brand"; round?: boolean;
}) {
  const content = <View style={[s.glassContent, round && s.round]}>{icon}{label ? <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.glassLabel}>{label}</Text> : null}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [s.glassShadow, pressed && { transform: [{ scale: 0.96 }] }]}>
    {tone === "brand" ? <View style={[s.glass, s.brand]}>{content}</View> : <GlassSurface style={s.glass} interactive>{content}</GlassSurface>}
  </Pressable>;
}

export function Badge({ count }: { count: number }) {
  return <View style={s.badge}><Text style={s.badgeText}>{count > 99 ? "99+" : count}</Text></View>;
}

/** Short confirmation above the bar; also announced to VoiceOver. */
export function Toast({ message, bottom }: { message: string | null; bottom: number }) {
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!message) return;
    AccessibilityInfo.announceForAccessibility?.(message);
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: false }).start();
  }, [message, opacity]);
  if (!message) return null;
  return <Animated.View pointerEvents="none" style={[s.toast, { bottom, opacity }]}><Text numberOfLines={2} style={s.toastText}>{message}</Text></Animated.View>;
}

/** One bottom sheet over a dimmed backdrop; its content may change while open. */
export function Sheet({ visible, title, onClose, left, right, children, large }: {
  visible: boolean; title: string; onClose: () => void; left?: ReactNode; right?: ReactNode; children: ReactNode; large?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const head = <><View style={s.grab} /><View style={s.sheetHead}>
    <View style={[s.sheetSide, { justifyContent: "flex-start" }]}>{left}</View>
    <Text accessibilityRole="header" numberOfLines={1} style={s.sheetTitle}>{title}</Text>
    <View style={[s.sheetSide, { justifyContent: "flex-end" }]}>{right}</View>
  </View></>;
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={s.backdropRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel="Zavrieť" style={StyleSheet.absoluteFill} onPress={onClose} />
      <SlideUp style={[s.sheet, large && s.sheetLarge, { paddingBottom: insets.bottom + space.m }]}>
        {head}<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.sheetBody}>{children}</ScrollView>
      </SlideUp>
    </View>
  </Modal>;
}
/** The sheet rises while the backdrop fades; Reduce Motion only fades. */
function SlideUp({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  const [offset] = useState(() => new Animated.Value(320));
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(reduce => {
      if (!alive) return;
      if (reduce) offset.setValue(0);
      else Animated.spring(offset, { toValue: 0, useNativeDriver: true, speed: 16, bounciness: 2 }).start();
    }).catch(() => offset.setValue(0));
    return () => { alive = false; };
  }, [offset]);
  return <Animated.View accessibilityViewIsModal style={[style, { transform: [{ translateY: offset }] }]}>{children}</Animated.View>;
}

/** Grouped rows with inset separators, as in iOS Settings. */
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.group, style]}>{children}</View>;
}
export function Row({ title, subtitle, leading, trailing, onPress, first, accessibilityLabel, tone }: {
  title: string; subtitle?: string | null; leading?: ReactNode; trailing?: ReactNode; onPress?: () => void; first?: boolean; accessibilityLabel?: string; tone?: "link" | "danger";
}) {
  const body = <>
    {!first && <View style={[s.separator, { left: leading ? 52 : space.m }]} />}
    {leading}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={2} style={[s.rowTitle, tone === "link" && { color: palette.brandInk }, tone === "danger" && { color: palette.redText }]}>{title}</Text>
      {subtitle ? <Text numberOfLines={2} style={s.rowSubtitle}>{subtitle}</Text> : null}
    </View>
    {trailing}
  </>;
  if (!onPress) return <View style={s.row}>{body}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: "#ECECF0" }]}>{body}</Pressable>;
}
export function SectionHeader({ title, detail }: { title: string; detail?: string | null }) {
  return <View style={s.sectionHeader}><Text accessibilityRole="header" style={s.sectionTitle}>{title}</Text>{detail ? <Text numberOfLines={1} style={s.sectionDetail}>{detail}</Text> : null}</View>;
}

export const shellStyles = StyleSheet.create({
  yellowButton: { minHeight: 44, borderRadius: 22, backgroundColor: palette.brand, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.s, paddingHorizontal: space.l },
  yellowButtonText: { ...type.rowTitle, color: palette.label },
});
const s = StyleSheet.create({
  miniBar: { height: 56, borderRadius: 28, backgroundColor: palette.background, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.separator, flexDirection: "row", alignItems: "center", paddingHorizontal: space.xs },
  miniItem: { flex: 1, minWidth: 0, alignItems: "center", gap: 2 },
  miniIcon: { height: 24, alignItems: "center", justifyContent: "center" },
  miniLabel: { fontSize: 9.5, lineHeight: 12, fontWeight: "600", color: "#3A3A3C" },
  segment: { flexDirection: "row", backgroundColor: palette.fill, borderRadius: 9, padding: 2 },
  segmentItem: { flex: 1, minHeight: 32, borderRadius: 7, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: space.xs },
  segmentSelected: { backgroundColor: palette.card, boxShadow: "0 1px 4px rgba(0,0,0,0.12)" },
  segmentText: { fontSize: 13, lineHeight: 17, fontWeight: "600", color: "#3A3A3C" },
  badge: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: palette.red, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  badgeText: { color: "#FFFFFF", fontSize: 11, lineHeight: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  glassShadow: { borderRadius: 20, boxShadow: "0 4px 14px rgba(0,0,0,0.08)" },
  glass: { borderRadius: 20, minHeight: 40, minWidth: 40, justifyContent: "center" },
  brand: { backgroundColor: palette.brand, borderWidth: 1, borderColor: "#F1DF6E", overflow: "hidden" },
  glassContent: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: space.m, minHeight: 40 },
  round: { paddingHorizontal: 0, width: 40 },
  glassLabel: { fontSize: 14, lineHeight: 18, fontWeight: "600", color: palette.label, flexShrink: 1 },
  toast: { position: "absolute", alignSelf: "center", maxWidth: "88%", backgroundColor: "rgba(28,28,30,0.92)", borderRadius: 18, paddingHorizontal: space.l, paddingVertical: 9, zIndex: 50 },
  toastText: { color: "#FFFFFF", fontSize: 13, lineHeight: 17, fontWeight: "600", textAlign: "center" },
  backdropRoot: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.28)" },
  sheet: { backgroundColor: palette.background, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: "88%", boxShadow: "0 -6px 30px rgba(0,0,0,0.18)" },
  sheetLarge: { height: "92%", maxHeight: "92%" },
  grab: { width: 38, height: 5, borderRadius: 3, backgroundColor: palette.tertiaryLabel, alignSelf: "center", marginTop: 7, marginBottom: 2 },
  sheetHead: { flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: 14, paddingVertical: 6 },
  sheetSide: { width: 96, flexDirection: "row" },
  sheetTitle: { ...type.headline, fontWeight: "700", color: palette.label, flex: 1, textAlign: "center" },
  sheetBody: { paddingBottom: space.xl },
  group: { marginHorizontal: space.l, backgroundColor: palette.card, borderRadius: radius.l, overflow: "hidden" },
  row: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: space.m, paddingVertical: 7, backgroundColor: palette.card },
  separator: { position: "absolute", top: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  rowTitle: { ...type.rowTitle, color: palette.label },
  rowSubtitle: { ...type.subhead, color: palette.secondaryLabel },
  sectionHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.s, paddingHorizontal: 20, paddingTop: space.l, paddingBottom: 6 },
  sectionTitle: { ...type.section, color: palette.label },
  sectionDetail: { ...type.caption, color: palette.secondaryLabel, flexShrink: 1, textAlign: "right" },
});
