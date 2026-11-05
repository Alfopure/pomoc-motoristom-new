import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Briefcase, Car, ClipboardList, FolderOpen, Phone, PhoneMissed, Search, type LucideIcon } from "lucide-react-native";
import type { MobileActiveCall } from "../../../src/lib/mobile-api";
import type { MobileCallbackSummary } from "../../../src/lib/mobile-callbacks";
import { palette, radius, space, type } from "../design/tokens";
import { columnsForWidth, gridItemWidth } from "../design/layout";
import { callStatus, formatNumber } from "../lib/display";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import { Group, Row, SectionHeader } from "../design/list";
import { ModulesMark, shellStyles } from "./parts";
import type { PresenceTone } from "./top-bar";
import type { ShellScope } from "./layers";
import { AlertsPreview, type AlertTargets } from "../alerts/ui";

export type HomeTarget = "console" | "callbacks" | "cases" | "tasks";
/** Organization-scoped reads; absent until the workspace scope is verified. */
export type HomeScope = ShellScope;
type Props = {
  active: boolean; phone: { label: string; tone: PresenceTone; detail: string };
  callbacks: UseQueryResult<MobileCallbackSummary>; activeCalls: MobileActiveCall[];
  scope: HomeScope | null; scopeNotice: string | null; tip: boolean; onDismissTip: () => void;
  onOpen: (target: HomeTarget) => void; onCall: (id: string) => void; onRefresh: () => void | Promise<unknown>; onSearch: () => void;
  alerts: { scope: ShellScope; targets: AlertTargets; onAll: () => void } | null;
  /** Someone who also delivers sees their deliveries here. */
  deliveries?: { count: number | null; detail: string; onOpen: () => void } | null;
  /** Someone who also drives or delivers in Moja práca sees that work here. */
  work?: { count: number | null; detail: string; onOpen: () => void } | null;
};
const toneColors: Record<PresenceTone, [string, string]> = {
  green: [palette.greenSoft, palette.greenText], orange: [palette.orangeSoft, palette.orangeText], red: [palette.redSoft, palette.redText], gray: [palette.fill, palette.secondaryLabel],
};

export function todayLabel(now = new Date()): string {
  try { return now.toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "numeric", timeZone: "Europe/Bratislava" }); }
  catch { return ""; }
}

/** Active calls and urgent work come before the broader work summary. */
export function HomeScreen({ active, phone, callbacks, activeCalls, scope, scopeNotice, tip, onDismissTip, onOpen, onCall, onRefresh, onSearch, alerts, deliveries, work }: Props) {
  const counts = callbacks.data?.counts;
  const { width, fontScale } = useWindowDimensions();
  const [gridWidth, setGridWidth] = useState(width - space.l * 2);
  const [refreshing, setRefreshing] = useState(false);
  const columns = columnsForWidth(gridWidth, fontScale, 152, 3, space.m);
  const tileWidth = gridItemWidth(gridWidth, columns, space.m);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); }
    finally { setRefreshing(false); }
  }
  return <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} />}>
    <View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>Prehľad</Text><Text style={s.date}>{todayLabel()}</Text></View>
    <Pressable accessibilityRole="search" accessibilityLabel="Hľadať prípad, EČV, telefón alebo modul" onPress={onSearch} style={({ pressed }) => [s.search, pressed && { opacity: 0.7 }]}>
      <Search size={20} color={palette.secondaryLabel} accessible={false} /><Text numberOfLines={1} style={s.searchText}>Hľadať v aplikácii</Text>
    </Pressable>
    {activeCalls.length > 0 && <>
      <SectionHeader title="Hovory na vašom účte" detail={activeCalls.length > 1 ? String(activeCalls.length) : null} />
      <Group>{activeCalls.map((call, index) => <Row key={call.id} first={index === 0} title={call.contactName || call.name || formatNumber(call.number)}
        subtitle={[callStatus(call.state), call.lineLabel].filter(Boolean).join(" · ")} onPress={() => onCall(call.id)}
        leading={<View style={[s.rowIcon, { backgroundColor: palette.greenSoft }]}><Phone size={16} color={palette.greenText} accessible={false} /></View>}
        trailing={<Text style={s.chevron}>›</Text>} accessibilityLabel={"Detail hovoru " + (call.contactName || call.name || formatNumber(call.number))} />)}</Group>
    </>}
    {alerts && <AlertsPreview scope={alerts.scope} active={active} targets={alerts.targets} onAll={alerts.onAll} />}
    <SectionHeader title="Vaša práca" />
    <View style={s.grid} onLayout={event => setGridWidth(Math.max(0, event.nativeEvent.layout.width - space.l * 2))}>
      <Tile width={tileWidth} title="Spätné volania" icon={PhoneMissed} colors={counts?.overdue ? toneColors.red : toneColors.orange} onPress={() => onOpen("callbacks")}
        value={callbacks.isPending ? null : counts ? String(counts.open) : "–"}
        detail={!counts ? (callbacks.isPending ? "Načítavam…" : "Počty nie sú dostupné") : counts.open === 0 ? "Nikto nečaká"
          : [counts.overdue > 0 ? `${counts.overdue} po termíne` : null, `${counts.mine} moje`, `${counts.unclaimed} voľné`].filter(Boolean).join(" · ")} />
      {scope ? <ScopedTiles active={active} scope={scope} onOpen={onOpen} tileWidth={tileWidth} /> : <>
        <Tile width={tileWidth} title="Prípady" icon={FolderOpen} colors={[palette.brandSoft, palette.brandInk]} value={null} detail={scopeNotice ?? "Overujem prístup…"} onPress={() => onOpen("cases")} />
        <Tile width={tileWidth} title="Moje úlohy" icon={ClipboardList} colors={[palette.blueSoft, palette.blueText]} value={null} detail={scopeNotice ?? "Overujem prístup…"} onPress={() => onOpen("tasks")} />
      </>}
      {deliveries && <Tile width={tileWidth} title="Pristavenia" icon={Car} colors={[palette.blueSoft, palette.blueText]} value={deliveries.count === null ? null : String(deliveries.count)}
        detail={deliveries.detail} onPress={deliveries.onOpen} />}
      {work && <Tile width={tileWidth} title="Moja práca" icon={Briefcase} colors={[palette.orangeSoft, palette.orangeText]} value={work.count === null ? null : String(work.count)}
        detail={work.detail} onPress={work.onOpen} />}
    </View>
    <SectionHeader title="Telefón" />
    <Group><Row first title={phone.label} subtitle={phone.detail} onPress={() => onOpen("console")}
      leading={<View style={[s.rowIcon, { backgroundColor: toneColors[phone.tone][0] }]}><Phone size={20} color={toneColors[phone.tone][1]} accessible={false} /></View>}
      trailing={<Text style={s.chevron}>›</Text>} accessibilityLabel={"Telefón: " + phone.label + ". " + phone.detail + ". Otvoriť ústredňu"} /></Group>
    {tip && <View style={s.tip}>
      <ModulesMark size={30} />
      <View style={{ flex: 1, gap: 2 }}><Text style={s.tipTitle}>Lištu si môžete prispôsobiť</Text>
        <Text style={s.tipText}>V Moduloch vyberte „Upraviť lištu“ a majte svoju prácu vždy po ruke.</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Rozumiem, skryť tip" onPress={onDismissTip} style={({ pressed }) => [s.tipButton, pressed && { opacity: 0.7 }]}>
        <Text style={shellStyles.yellowButtonText}>Rozumiem</Text></Pressable>
    </View>}
  </ScrollView>;
}

function ScopedTiles({ active, scope, onOpen, tileWidth }: { active: boolean; scope: HomeScope; onOpen: (target: HomeTarget) => void; tileWidth: number }) {
  // Own key: hidden module screens cancel reads under their own prefixes.
  const overview = useQuery({ queryKey: [...scope.homeKey, "case-overview"], queryFn: ({ signal }) => scope.cases.overview(signal), enabled: active, refetchInterval: active ? 60_000 : false });
  const tasks = useQuery({ queryKey: [...scope.homeKey, "tasks"], enabled: active, refetchInterval: active ? 60_000 : false,
    queryFn: ({ signal }) => scope.cases.work.myTasks({ view: "assigned", category: "open", q: "" }, signal) });
  const cases = overview.data?.counts;
  return <>
    <Tile width={tileWidth} title="Prípady" icon={FolderOpen} colors={[palette.brandSoft, palette.brandInk]} onPress={() => onOpen("cases")}
      value={overview.isPending ? null : cases ? String(cases.open) : "–"}
      detail={!cases ? (overview.isPending ? "Načítavam…" : "Počty nie sú dostupné")
        : [cases.urgent > 0 ? `${cases.urgent} horí` : null, `${cases.mine} moje`, `${cases.unassigned} nepriradené`].filter(Boolean).join(" · ")} />
    <Tile width={tileWidth} title="Moje úlohy" icon={ClipboardList} colors={[palette.blueSoft, palette.blueText]} onPress={() => onOpen("tasks")}
      value={tasks.isPending ? null : tasks.data ? String(tasks.data.tasks.length) + (tasks.data.nextCursor ? "+" : "") : "–"}
      detail={tasks.isPending ? "Načítavam…" : tasks.data ? (tasks.data.tasks.length ? "otvorené, priradené vám" : "Žiadne otvorené") : "Úlohy nie sú dostupné"} />
  </>;
}

function Tile({ title, icon: Icon, colors, value, detail, onPress, width }: {
  title: string; icon: LucideIcon; colors: [string, string]; value: string | null; detail: string; onPress: () => void; width: number;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title + (value ? ": " + value : "") + ". " + detail} onPress={onPress}
    style={({ pressed }) => [s.tile, { width }, pressed && { opacity: 0.75 }]}>
    <View style={s.tileHead}><View style={[s.tileIcon, { backgroundColor: colors[0] }]}><Icon size={19} strokeWidth={2} color={colors[1]} accessible={false} /></View>
      <Text style={s.tileTitle}>{title}</Text></View>
    <View style={s.tileBody}>
      {value === null ? <ActivityIndicator accessibilityLabel="Načítavam počet" style={s.spinner} color={palette.secondaryLabel} /> : <Text style={s.tileValue}>{value}</Text>}
      <Text style={s.tileDetail}>{detail}</Text>
    </View>
  </Pressable>;
}
const s = StyleSheet.create({
  content: { paddingBottom: NAVIGATION_CONTENT_BOTTOM, gap: 0 },
  titleRow: { gap: space.xs, paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.l },
  title: { ...type.title, color: palette.label },
  date: { ...type.subhead, color: palette.secondaryLabel },
  search: { marginHorizontal: space.l, marginBottom: space.xs, minHeight: 48, borderRadius: radius.m, backgroundColor: palette.fill, flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: space.m, paddingVertical: space.s },
  searchText: { ...type.body, color: palette.secondaryLabel, flex: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.m, paddingHorizontal: space.l },
  tile: { minHeight: 132, backgroundColor: palette.card, borderRadius: radius.l, borderCurve: "continuous", padding: space.l, justifyContent: "space-between", gap: space.m },
  tileHead: { flexDirection: "row", alignItems: "center", gap: space.s },
  tileIcon: { width: 32, height: 32, borderRadius: radius.s, alignItems: "center", justifyContent: "center" },
  tileTitle: { ...type.rowTitle, color: palette.label, flex: 1, minWidth: 0 },
  tileBody: { gap: space.xs },
  tileValue: { ...type.number, color: palette.label },
  tileDetail: { ...type.subhead, color: palette.secondaryLabel },
  spinner: { alignSelf: "flex-start", height: 29 },
  rowIcon: { width: 36, height: 36, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  chevron: { ...type.objectTitle, color: palette.secondaryLabel },
  tip: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.m, marginHorizontal: space.l, marginTop: space.l, padding: space.l, borderRadius: radius.l, backgroundColor: palette.card },
  tipTitle: { ...type.rowTitle, color: palette.label },
  tipText: { ...type.subhead, color: palette.secondaryLabel },
  tipButton: { minHeight: 44, borderRadius: radius.xl, backgroundColor: palette.brand, alignItems: "center", justifyContent: "center", paddingHorizontal: space.l, paddingVertical: space.s },
});
