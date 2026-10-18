import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ClipboardList, FolderOpen, Phone, PhoneMissed, Search, type LucideIcon } from "lucide-react-native";
import type { MobileActiveCall } from "../../../src/lib/mobile-api";
import type { MobileCallbackSummary } from "../../../src/lib/mobile-callbacks";
import type { CasesApi } from "../cases/api";
import { palette, radius, space, type } from "../design/tokens";
import { callStatus, formatNumber } from "../lib/display";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import { Group, Row, SectionHeader } from "../design/list";
import { ModulesMark, shellStyles } from "./parts";
import type { PresenceTone } from "./top-bar";

export type HomeTarget = "console" | "callbacks" | "cases" | "tasks";
/** Organization-scoped reads; absent until the workspace scope is verified. */
export type HomeScope = { cases: CasesApi; homeKey: readonly unknown[] };
type Props = {
  active: boolean; phone: { label: string; tone: PresenceTone; detail: string };
  callbacks: UseQueryResult<MobileCallbackSummary>; activeCalls: MobileActiveCall[];
  scope: HomeScope | null; scopeNotice: string | null; tip: boolean; onDismissTip: () => void;
  onOpen: (target: HomeTarget) => void; onCall: (id: string) => void; onRefresh: () => void; onSearch: () => void;
};
const toneColors: Record<PresenceTone, [string, string]> = {
  green: [palette.greenSoft, palette.greenText], orange: [palette.orangeSoft, palette.orangeText], red: [palette.redSoft, palette.redText], gray: [palette.fill, palette.secondaryLabel],
};

export function todayLabel(now = new Date()): string {
  try { return now.toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "numeric", timeZone: "Europe/Bratislava" }); }
  catch { return ""; }
}

/** What needs attention now: live calls first, then one tile per module. */
export function HomeScreen({ active, phone, callbacks, activeCalls, scope, scopeNotice, tip, onDismissTip, onOpen, onCall, onRefresh, onSearch }: Props) {
  const counts = callbacks.data?.counts;
  return <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} />}>
    <View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>Prehľad</Text><Text style={s.date}>{todayLabel()}</Text></View>
    <Pressable accessibilityRole="search" accessibilityLabel="Hľadať prípad, EČV, telefón alebo modul" onPress={onSearch} hitSlop={{ top: 3, bottom: 3 }} style={({ pressed }) => [s.search, pressed && { opacity: 0.7 }]}>
      <Search size={16} color={palette.secondaryLabel} accessible={false} /><Text numberOfLines={1} style={s.searchText}>Hľadať prípad, EČV, telefón, modul…</Text>
    </Pressable>
    {activeCalls.length > 0 && <>
      <SectionHeader title="Hovory na vašom účte" detail={activeCalls.length > 1 ? String(activeCalls.length) : null} />
      <Group>{activeCalls.map((call, index) => <Row key={call.id} first={index === 0} title={call.name || formatNumber(call.number)}
        subtitle={[callStatus(call.state), call.lineLabel].filter(Boolean).join(" · ")} onPress={() => onCall(call.id)}
        leading={<View style={[s.rowIcon, { backgroundColor: palette.greenSoft }]}><Phone size={16} color={palette.greenText} accessible={false} /></View>}
        trailing={<Text style={s.chevron}>›</Text>} accessibilityLabel={"Detail hovoru " + (call.name || formatNumber(call.number))} />)}</Group>
    </>}
    <View style={s.grid}>
      <Tile title="Spätné volania" icon={PhoneMissed} colors={counts?.overdue ? toneColors.red : toneColors.orange} onPress={() => onOpen("callbacks")}
        value={callbacks.isPending ? null : counts ? String(counts.open) : "–"}
        detail={!counts ? (callbacks.isPending ? "Načítavam…" : "Počty nie sú dostupné") : counts.open === 0 ? "Nikto nečaká"
          : <>{counts.overdue > 0 && <Text style={s.alert}>{counts.overdue} po termíne · </Text>}{counts.mine} moje · {counts.unclaimed} voľné</>} />
      {scope ? <ScopedTiles active={active} scope={scope} onOpen={onOpen} /> : <>
        <Tile title="Prípady" icon={FolderOpen} colors={[palette.brandSoft, palette.brandInk]} value={null} detail={scopeNotice ?? "Overujem prístup…"} onPress={() => onOpen("cases")} />
        <Tile title="Moje úlohy" icon={ClipboardList} colors={[palette.blueSoft, palette.blueText]} value={null} detail={scopeNotice ?? "Overujem prístup…"} onPress={() => onOpen("tasks")} />
      </>}
      <Tile title="Telefón" icon={Phone} colors={toneColors[phone.tone]} value={phone.label} small detail={phone.detail} onPress={() => onOpen("console")} />
    </View>
    {tip && <View style={s.tip}>
      <ModulesMark size={30} />
      <View style={{ flex: 1, gap: 2 }}><Text style={s.tipTitle}>Všetky moduly sú pod žltou ikonou Moduly</Text>
        <Text style={s.tipText}>Vpravo dole v lište. Tam si cez „Upraviť lištu“ vyberiete, čo chcete mať stále po ruke.</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Rozumiem, skryť tip" onPress={onDismissTip} hitSlop={8} style={({ pressed }) => [s.tipButton, pressed && { opacity: 0.7 }]}>
        <Text style={shellStyles.yellowButtonText}>OK</Text></Pressable>
    </View>}
  </ScrollView>;
}

function ScopedTiles({ active, scope, onOpen }: { active: boolean; scope: HomeScope; onOpen: (target: HomeTarget) => void }) {
  // Own key: hidden module screens cancel reads under their own prefixes.
  const overview = useQuery({ queryKey: [...scope.homeKey, "case-overview"], queryFn: ({ signal }) => scope.cases.overview(signal), enabled: active, refetchInterval: active ? 60_000 : false });
  const tasks = useQuery({ queryKey: [...scope.homeKey, "tasks"], enabled: active, refetchInterval: active ? 60_000 : false,
    queryFn: ({ signal }) => scope.cases.work.myTasks({ view: "assigned", category: "open", q: "" }, signal) });
  const cases = overview.data?.counts;
  return <>
    <Tile title="Prípady" icon={FolderOpen} colors={[palette.brandSoft, palette.brandInk]} onPress={() => onOpen("cases")}
      value={overview.isPending ? null : cases ? String(cases.open) : "–"}
      detail={!cases ? (overview.isPending ? "Načítavam…" : "Počty nie sú dostupné")
        : <>{cases.urgent > 0 && <Text style={s.alert}>{cases.urgent} horí · </Text>}{cases.mine} moje · {cases.unassigned} nepriradené</>} />
    <Tile title="Moje úlohy" icon={ClipboardList} colors={[palette.blueSoft, palette.blueText]} onPress={() => onOpen("tasks")}
      value={tasks.isPending ? null : tasks.data ? String(tasks.data.tasks.length) + (tasks.data.nextCursor ? "+" : "") : "–"}
      detail={tasks.isPending ? "Načítavam…" : tasks.data ? (tasks.data.tasks.length ? "otvorené, priradené vám" : "Žiadne otvorené") : "Úlohy nie sú dostupné"} />
  </>;
}

function Tile({ title, icon: Icon, colors, value, detail, onPress, small }: {
  title: string; icon: LucideIcon; colors: [string, string]; value: string | null; detail: ReactNode; onPress: () => void; small?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title + (value ? ": " + value : "")} onPress={onPress}
    style={({ pressed }) => [s.tile, pressed && { transform: [{ scale: 0.98 }], opacity: 0.9 }]}>
    <View style={s.tileHead}><View style={[s.tileIcon, { backgroundColor: colors[0] }]}><Icon size={13} strokeWidth={2.4} color={colors[1]} accessible={false} /></View>
      <Text numberOfLines={1} style={s.tileTitle}>{title}</Text></View>
    <View>
      {value === null ? <ActivityIndicator style={s.spinner} color={palette.secondaryLabel} /> : <Text numberOfLines={1} adjustsFontSizeToFit style={small ? s.tileValueSmall : s.tileValue}>{value}</Text>}
      <Text numberOfLines={2} style={s.tileDetail}>{detail}</Text>
    </View>
  </Pressable>;
}
const s = StyleSheet.create({
  content: { paddingBottom: NAVIGATION_CONTENT_BOTTOM, gap: 0 },
  titleRow: { flexDirection: "row", alignItems: "baseline", gap: space.s, paddingHorizontal: space.l, paddingTop: 2, paddingBottom: space.s, flexWrap: "wrap" },
  title: { ...type.title, color: palette.label },
  date: { ...type.subhead, fontWeight: "500", color: palette.secondaryLabel },
  search: { marginHorizontal: space.l, marginBottom: space.xs, minHeight: 38, borderRadius: 19, backgroundColor: palette.fill, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: space.m },
  searchText: { fontSize: 16, color: palette.secondaryLabel, flex: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: space.l, paddingTop: space.s },
  tile: { flexBasis: "47%", flexGrow: 1, minHeight: 92, backgroundColor: palette.card, borderRadius: radius.l, paddingHorizontal: space.m, paddingVertical: 11, justifyContent: "space-between", gap: space.s },
  tileHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  tileIcon: { width: 22, height: 22, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  tileTitle: { ...type.caption, fontWeight: "600", color: palette.secondaryLabel, flex: 1 },
  tileValue: { ...type.number, color: palette.label },
  tileValueSmall: { fontSize: 19, lineHeight: 29, fontWeight: "700", letterSpacing: -0.3, color: palette.label },
  tileDetail: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel },
  alert: { color: palette.redText, fontWeight: "700" },
  spinner: { alignSelf: "flex-start", height: 29 },
  rowIcon: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
  tip: { flexDirection: "row", alignItems: "center", gap: space.m, marginHorizontal: space.l, marginTop: space.l, padding: space.m, borderRadius: radius.l, backgroundColor: palette.card },
  tipTitle: { ...type.rowTitle, fontSize: 14, color: palette.label },
  tipText: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel },
  tipButton: { minHeight: 36, minWidth: 48, borderRadius: 18, backgroundColor: palette.brand, alignItems: "center", justifyContent: "center", paddingHorizontal: space.m },
});
