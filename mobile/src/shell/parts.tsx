import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Briefcase, Building, Car, ClipboardList, FolderOpen, House, LayoutGrid, Phone, Plus, Wrench, type LucideIcon } from "lucide-react-native";
import { palette, radius, space, type } from "../design/tokens";
import { columnsForWidth, gridItemWidth } from "../design/layout";
import { GlassSurface } from "../ui/glass";
import { moduleById, type ModuleId } from "./modules";
import type { ShellTab } from "./navigation";

export const moduleIcons: Record<ModuleId, LucideIcon> = { hovory: Phone, pripady: FolderOpen, ulohy: ClipboardList, nastroje: Wrench, pristavenia: Car, praca: Briefcase, pobocka: Building };
export const tabLabel = (tab: ShellTab) => tab === "prehlad" ? "Prehľad" : tab === "moduly" ? "Moduly" : tab === "pristavenia" ? "Pristav." : moduleById(tab).short;

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
      <Text numberOfLines={2} maxFontSizeMultiplier={1.5} style={[s.miniLabel, item === "add" && { color: palette.tertiaryLabel }]}>{item === "add" ? "voľné" : tabLabel(item)}</Text>
    </View>)}
  </View>;
}

export function Segmented<T extends string>({ items, value, onChange, accessibilityLabel }: {
  items: { id: T; label: string; badge?: number | null }[]; value: T; onChange: (value: T) => void; accessibilityLabel: string;
}) {
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(windowWidth - space.l * 2);
  const columns = columnsForWidth(width - 4, fontScale, 76, items.length, 4);
  return <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={s.segment} onLayout={event => setWidth(event.nativeEvent.layout.width)}>{items.map(item => {
    const selected = item.id === value;
    return <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={item.label + (item.badge ? ", " + item.badge : "")}
      onPress={() => onChange(item.id)} style={({ pressed }) => [s.segmentItem, { width: gridItemWidth(width - 4, columns, 4) }, selected && s.segmentSelected, pressed && !selected && { opacity: 0.6 }]}>
      <Text style={[s.segmentText, selected && { color: palette.label }]}>{item.label}</Text>
      {Boolean(item.badge) && <View style={s.badge}><Text style={s.badgeText}>{item.badge! > 99 ? "99+" : item.badge}</Text></View>}
    </Pressable>;
  })}</View>;
}

/** Glass control for the top bar; text and icon stay readable in every surface. */
export function GlassButton({ label, accessibilityLabel, icon, onPress, tone = "glass", round, disabled }: {
  label?: string; accessibilityLabel: string; icon?: ReactNode; onPress: () => void; tone?: "glass" | "brand"; round?: boolean; disabled?: boolean;
}) {
  const content = <View style={[s.glassContent, round && !label && s.round, disabled && { opacity: 0.4 }]}>{icon}{label ? <Text style={s.glassLabel}>{label}</Text> : null}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityShowsLargeContentViewer accessibilityLargeContentTitle={label ?? accessibilityLabel} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [s.glassShadow, pressed && !disabled && { opacity: 0.72 }]}>
    {tone === "brand" ? <View style={[s.glass, s.brand]}>{content}</View> : <GlassSurface style={s.glass} interactive>{content}</GlassSurface>}
  </Pressable>;
}

export function Badge({ count }: { count: number }) {
  return <View style={s.badge}><Text style={s.badgeText}>{count > 99 ? "99+" : count}</Text></View>;
}

function useReduceMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let alive = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", value => { changed = true; if (alive) setReduced(value); });
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive && !changed) setReduced(value); }).catch(() => undefined);
    return () => { alive = false; subscription.remove(); };
  }, []);
  return reduced;
}

/** Short confirmation above the bar; also announced to VoiceOver. */
export function Toast({ message, bottom }: { message: string | null; bottom: number }) {
  useEffect(() => {
    if (message) AccessibilityInfo.announceForAccessibility?.(message);
  }, [message]);
  if (!message) return null;
  return <View pointerEvents="none" style={[s.toast, { bottom }]}><Text style={s.toastText}>{message}</Text></View>;
}

/** One bottom sheet over a dimmed backdrop; its content may change while open. */
export function Sheet({ visible, title, onClose, left, right, children, large }: {
  visible: boolean; title: string; onClose: () => void; left?: ReactNode; right?: ReactNode; children: ReactNode; large?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  return <Modal visible={visible} transparent animationType={reduceMotion ? "none" : "fade"} onRequestClose={onClose}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.backdropRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel="Zavrieť" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View accessibilityViewIsModal style={[s.sheet, large && s.sheetLarge, { paddingBottom: insets.bottom + space.m }]}>
        <View style={s.grab} />
        <Text accessibilityRole="header" style={s.sheetTitle}>{title}</Text>
        <View style={s.sheetHead}>
          <View style={s.sheetSide}>{left}</View>
          <View style={[s.sheetSide, { alignItems: "flex-end" }]}>{right ?? (!left ? <GlassButton label="Zavrieť" accessibilityLabel="Zavrieť okno" onPress={onClose} /> : null)}</View>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={s.sheetBody}>{children}</ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
export const shellStyles = StyleSheet.create({
  yellowButton: { minHeight: 44, borderRadius: 22, backgroundColor: palette.brand, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.s, paddingHorizontal: space.l },
  yellowButtonText: { ...type.rowTitle, color: palette.label },
});
const s = StyleSheet.create({
  miniBar: { minHeight: 68, paddingVertical: space.s, borderRadius: 28, backgroundColor: palette.background, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.separator, flexDirection: "row", alignItems: "center", paddingHorizontal: space.xs },
  miniItem: { flex: 1, minWidth: 0, alignItems: "center", gap: 2 },
  miniIcon: { height: 24, alignItems: "center", justifyContent: "center" },
  miniLabel: { ...type.tabLabel, maxWidth: "100%", color: palette.secondaryLabel, textAlign: "center" },
  segment: { flexDirection: "row", flexWrap: "wrap", gap: 4, backgroundColor: palette.fill, borderRadius: radius.m, padding: 2 },
  segmentItem: { flexGrow: 1, minHeight: 44, borderRadius: 10, paddingVertical: space.s, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: space.xs },
  segmentSelected: { backgroundColor: palette.card, boxShadow: "0 1px 4px rgba(0,0,0,0.12)" },
  segmentText: { ...type.subhead, fontWeight: "600", color: palette.secondaryLabel, flexShrink: 1, textAlign: "center" },
  badge: { minWidth: 20, minHeight: 20, borderRadius: 12, backgroundColor: palette.redText, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  badgeText: { color: palette.card, ...type.tag, fontVariant: ["tabular-nums"] },
  glassShadow: { borderRadius: 22, maxWidth: "100%", flexShrink: 1, boxShadow: "0 4px 14px rgba(0,0,0,0.08)" },
  glass: { borderRadius: 22, minHeight: 44, minWidth: 44, justifyContent: "center" },
  brand: { backgroundColor: palette.brand, borderWidth: 1, borderColor: "#F1DF6E", overflow: "hidden" },
  glassContent: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: space.m, minHeight: 44, paddingVertical: space.s },
  round: { paddingHorizontal: 0, width: 44 },
  glassLabel: { ...type.subhead, fontWeight: "600", color: palette.label, flexShrink: 1 },
  toast: { position: "absolute", alignSelf: "center", maxWidth: "88%", backgroundColor: "rgba(28,28,30,0.92)", borderRadius: 18, paddingHorizontal: space.l, paddingVertical: 9, zIndex: 50 },
  toastText: { color: "#FFFFFF", fontSize: 13, lineHeight: 17, fontWeight: "600", textAlign: "center" },
  backdropRoot: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.28)" },
  sheet: { backgroundColor: palette.background, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: "88%", boxShadow: "0 -6px 30px rgba(0,0,0,0.18)" },
  sheetLarge: { height: "92%", maxHeight: "92%" },
  grab: { width: 38, height: 5, borderRadius: 3, backgroundColor: palette.tertiaryLabel, alignSelf: "center", marginTop: 7, marginBottom: 2 },
  sheetHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.s, paddingHorizontal: space.l, paddingBottom: space.s },
  sheetSide: { flexShrink: 1, minWidth: 0 },
  sheetTitle: { ...type.headline, fontWeight: "700", color: palette.label, textAlign: "center", paddingHorizontal: space.l, paddingVertical: space.m },
  sheetBody: { paddingBottom: space.xl },
});
