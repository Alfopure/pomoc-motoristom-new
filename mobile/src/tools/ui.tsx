import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CarFront, ChevronRight, MapPinned, Route, Truck } from "lucide-react-native";
import type { CasesApi } from "../cases/api";
import { CaseMapFrame } from "../cases/map-frame";
import { CasePlacePicker } from "../cases/case-place-picker";
import { useAndroidBack } from "../lib/use-android-back";
import { useShellBack } from "../shell/back";
import { Card, colors, styles } from "../ui";
import type { ToolsApi } from "./api";
import { VehicleLookup } from "./lookup";
import { RouteTool, type ToolMapPick, type ToolMapView } from "./route";
import { FleetTool } from "./fleet";
import { MapTool } from "./map";

type Tool = "home" | "lookup" | "route" | "map" | "fleet";
type Props = { api: ToolsApi; maps: CasesApi; scopeKey: string; active: boolean; visible: boolean; mapBlocked?: boolean; onClose: () => void };
type MapContent = { mode: "pick"; request: ToolMapPick } | { mode: "view"; request: ToolMapView };
type MapOverlay = MapContent & { id: number };
const entries = [
  { id: "lookup", title: "Dohľadať vozidlo", description: "EČV, VIN a údaje dostupných zdrojov", icon: CarFront },
  { id: "route", title: "Vypočítať trasu", description: "Jazdná vzdialenosť, čas a body prejazdu", icon: Route },
  { id: "map", title: "Mapa", description: "Vybrať miesto a otvoriť navigáciu", icon: MapPinned },
  { id: "fleet", title: "Flotila", description: "Vozidlá, obsadenosť a uložené GPS polohy", icon: Truck },
] as const;

export function ToolsWorkspace(props: Props) { return <ScopedToolsWorkspace key={props.scopeKey} {...props} />; }

function ScopedToolsWorkspace({ api, maps, scopeKey, active, visible, mapBlocked = false, onClose }: Props) {
  const [tool, setTool] = useState<Tool>("home"), [map, setMap] = useState<MapOverlay | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0), context = useRef({ active, visible, mapBlocked, mapId: map?.id });
  const [availability, setAvailability] = useState({ visible, mapBlocked });
  if (availability.visible !== visible || availability.mapBlocked !== mapBlocked) {
    setAvailability({ visible, mapBlocked });
    if (!visible || mapBlocked) setMap(null);
  }
  const foreground = active && visible;
  const closeMap = () => { sequence.current++; setMap(null); };
  useLayoutEffect(() => {
    const state = context.current;
    Object.assign(state, { active, visible, mapBlocked, mapId: map?.id });
    return () => { state.active = false; state.visible = false; };
  }, [active, visible, mapBlocked, map?.id]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      if (state === "background" || state === "inactive" && Platform.OS !== "ios") { sequence.current++; setMap(null); }
    });
    return () => subscription.remove();
  }, []);
  const back = () => { if (tool === "home") onClose(); else { closeMap(); setNotice(null); setTool("home"); } };
  useAndroidBack(foreground && !map, back);
  useShellBack(foreground && tool !== "home", "Nástroje", back);
  function openMap(value: MapContent) {
    if (!context.current.active || !context.current.visible) return;
    if (context.current.mapBlocked) { setNotice("Počas hovoru zostáva ovládanie telefónu v popredí. Mapu môžete otvoriť po ukončení hovoru."); return; }
    setNotice(null); setMap({ ...value, id: ++sequence.current });
  }
  const pick = (request: ToolMapPick) => openMap({ mode: "pick", request });
  const view = (request: ToolMapView) => openMap({ mode: "view", request });
  return <>
    <KeyboardAvoidingView style={visible ? { flex: 1 } : s.hidden} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.heading}>{tool === "home" ? "Nástroje" : entries.find(entry => entry.id === tool)?.title}</Text>
        {notice && <Card><Text accessibilityRole="alert" style={styles.text}>{notice}</Text></Card>}
        {tool === "home" && <>
          <Text style={styles.muted}>Všetko potrebné pre ďalší zásah.</Text>
          {entries.map(entry => <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={entry.title} onPress={() => { setNotice(null); setTool(entry.id); }}
            style={({ pressed }) => [styles.card, s.entry, pressed && { opacity: 0.7 }]}>
            <View style={s.icon}><entry.icon size={19} color={colors.ink} accessible={false} /></View>
            <View style={s.caption}><Text style={styles.subheading}>{entry.title}</Text><Text style={styles.muted}>{entry.description}</Text></View>
            <ChevronRight size={20} color={colors.muted} accessible={false} />
          </Pressable>)}
        </>}
        <View style={tool === "lookup" ? s.tool : s.hidden}><VehicleLookup api={api} active={foreground && tool === "lookup"} /></View>
        <View style={tool === "route" ? s.tool : s.hidden}><RouteTool api={api} active={foreground && tool === "route"} pick={pick} view={view} /></View>
        <View style={tool === "fleet" ? s.tool : s.hidden}><FleetTool api={api} active={foreground && tool === "fleet"} view={view} /></View>
        <View style={tool === "map" ? s.tool : s.hidden}><MapTool active={foreground && tool === "map"} scopeKey={scopeKey} pick={pick} /></View>
      </ScrollView>
    </KeyboardAvoidingView>
    {visible && !mapBlocked && map?.mode === "pick" && <CasePlacePicker key={map.id} api={maps} caseId={null} target="pickup" seed={map.request.seed}
      active={active} visible={visible} title={map.request.title} selectionNotice="Výber sa použije iba v tomto nástroji. Prípad sa tým nemení."
      deviceLocationNotice="Poloha tohto telefónu, nie zákazníka. Použite ju iba ako bod, z ktorého chcete plánovať trasu."
      onClose={closeMap} onApply={selection => {
        if (context.current.active && context.current.visible && !context.current.mapBlocked && context.current.mapId === map.id && sequence.current === map.id) map.request.onApply(selection);
      }} />}
    {foreground && !mapBlocked && map?.mode === "view" && <CaseMapFrame key={map.id} api={maps} caseId={null} mode="view" target="pickup" seed={map.request.seed} title={map.request.title} onClose={closeMap} />}
  </>;
}
const s = StyleSheet.create({
  entry: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64 },
  icon: { width: 34, height: 34, borderRadius: 10, backgroundColor: "#FFF5B8", alignItems: "center", justifyContent: "center" },
  caption: { flex: 1, minWidth: 0, gap: 2 }, tool: { gap: 12 }, hidden: { display: "none" },
});
