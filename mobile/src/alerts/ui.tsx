import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, ClipboardList, Flame, PhoneMissed, type LucideIcon } from "lucide-react-native";
import { Tag } from "../design/detail";
import { Group, Row, SectionHeader } from "../design/list";
import { palette, space, type } from "../design/tokens";
import { MobileApiError } from "../lib/api";
import { ErrorNotice } from "../ui";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import type { ShellOpeners, ShellScope } from "../shell/layers";
import { alertSummary, callbackAlerts, caseAlerts, sortAlerts, taskAlerts, type AlertItem, type AlertKind } from "./model";

const icons: Record<AlertKind, LucideIcon> = { callback: PhoneMissed, task: ClipboardList, case: Flame };
const errorText = (error: unknown) => error instanceof MobileApiError ? error.message : "Nepodarilo sa načítať.";
export type AlertTargets = ShellOpeners & { openCallbacks: () => void };

/** Reads at most one page of each source; shares the task read with Prehľad. */
export function useAlerts(scope: ShellScope, active: boolean) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    // Back in the foreground the clock restarts at once, not after the next tick.
    const tick = () => setClock(Date.now()), first = setTimeout(tick, 0), timer = setInterval(tick, 30_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [active]);
  const poll = active ? 60_000 : false;
  const callbacks = useQuery({ queryKey: [...scope.homeKey, "alerts", "callbacks"], enabled: active, refetchInterval: poll, queryFn: ({ signal }) => scope.callbacks.list(null, signal) });
  const tasks = useQuery({ queryKey: [...scope.homeKey, "tasks"], enabled: active, refetchInterval: poll,
    queryFn: ({ signal }) => scope.cases.work.myTasks({ view: "assigned", category: "open", q: "" }, signal) });
  const cases = useQuery({ queryKey: [...scope.homeKey, "alerts", "urgent"], enabled: active, refetchInterval: poll,
    queryFn: ({ signal }) => scope.cases.list({ ownership: "all", ownerId: null, category: "open", status: null, priority: "urgent", q: "", cursor: null }, signal) });
  // Fresh data is never judged against an older clock.
  const now = Math.max(clock, callbacks.dataUpdatedAt, tasks.dataUpdatedAt, cases.dataUpdatedAt);
  const items = useMemo(() => sortAlerts([...callbackAlerts(callbacks.data?.open ?? [], now), ...taskAlerts(tasks.data?.tasks ?? [], now), ...caseAlerts(cases.data?.cases ?? [])]),
    [callbacks.data, tasks.data, cases.data, now]);
  return {
    // Pending means no data yet, so nothing may be claimed until every source answered.
    items, loading: callbacks.isPending || tasks.isPending || cases.isPending,
    /** A source failed; its items may be missing or out of date. */
    failed: callbacks.isError || tasks.isError || cases.isError,
    sources: { callback: callbacks, task: tasks, case: cases },
    /** The source has further pages that were not read. */
    more: { callback: Boolean(callbacks.data?.nextCursor), task: Boolean(tasks.data?.nextCursor), case: Boolean(cases.data?.nextCursor) } satisfies Record<AlertKind, boolean>,
    partial: Boolean(callbacks.data?.nextCursor || tasks.data?.nextCursor || cases.data?.nextCursor),
    refresh: () => Promise.allSettled([callbacks.refetch(), tasks.refetch(), cases.refetch()]),
  };
}
type Alerts = ReturnType<typeof useAlerts>;
const summary = (alerts: Alerts) => alertSummary({ count: alerts.items.length, partial: alerts.partial, failed: alerts.failed });
function Retry({ alerts }: { alerts: Alerts }) {
  return <View style={s.retry}><ErrorNotice message="Niektoré upozornenia sa nepodarilo načítať." onRetry={() => { void alerts.refresh(); }} /></View>;
}

function open(item: AlertItem, targets: AlertTargets) {
  if (item.kind === "callback") targets.openCallbacks();
  else if (item.kind === "task") targets.openTask(item.id);
  else targets.openCase(item.id);
}
/** Title on one line, then the deadline tag and where it comes from. */
function AlertRow({ item, first, targets }: { item: AlertItem; first: boolean; targets: AlertTargets }) {
  const Icon = icons[item.kind];
  return <Pressable accessibilityRole="button" accessibilityLabel={item.title + ", " + item.tag + ". " + item.detail} onPress={() => open(item, targets)}
    style={({ pressed }) => [s.row, pressed && { backgroundColor: "#ECECF0" }]}>
    {!first && <View style={s.separator} />}
    <View style={[s.icon, { backgroundColor: item.tone === "red" ? palette.redSoft : palette.orangeSoft }]}>
      <Icon size={15} strokeWidth={2.3} color={item.tone === "red" ? palette.redText : palette.orangeText} accessible={false} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text numberOfLines={1} style={s.rowTitle}>{item.title}</Text>
      <View style={s.rowMeta}>{item.tag ? <Tag text={item.tag} tone={item.tone} /> : null}<Text numberOfLines={1} style={s.rowDetail}>{item.detail}</Text></View>
    </View>
    <Text style={s.chevron}>›</Text>
  </Pressable>;
}

/** Prehľad section: the few most pressing items and a way to all of them. */
export function AlertsPreview({ scope, active, targets, onAll }: { scope: ShellScope; active: boolean; targets: AlertTargets; onAll: () => void }) {
  const alerts = useAlerts(scope, active);
  const shown = alerts.items.slice(0, 4), { count, empty } = summary(alerts);
  return <>
    <SectionHeader title="Treba riešiť" detail={alerts.loading ? null : count} />
    {alerts.loading ? <ActivityIndicator color={palette.secondaryLabel} /> : <>
      {alerts.failed && <Retry alerts={alerts} />}
      <Group>
        {shown.map((item, index) => <AlertRow key={item.key} item={item} first={index === 0} targets={targets} />)}
        {empty && <Row first title={empty.title} subtitle={empty.subtitle} leading={!empty.clear ? null
          : <View style={[s.icon, { backgroundColor: palette.greenSoft }]}><CircleCheck size={15} strokeWidth={2.3} color={palette.greenText} accessible={false} /></View>} />}
        <Row first={shown.length === 0 && !empty} title={"Všetky upozornenia" + (alerts.items.length > shown.length || alerts.partial ? " (" + count + ")" : "")} tone="link"
          onPress={onAll} trailing={<Text style={s.chevron}>›</Text>} />
      </Group>
    </>}
  </>;
}

const sections: { kind: AlertKind; title: string; empty: string; link: string; open: (targets: AlertTargets) => void }[] = [
  { kind: "callback", title: "Spätné volania", empty: "Žiadna požiadavka po termíne ani pred termínom do 15 minút.", link: "Otvoriť spätné volania", open: targets => targets.openCallbacks() },
  { kind: "task", title: "Moje úlohy", empty: "Žiadna vaša úloha na dnes ani po termíne.", link: "Všetky moje úlohy", open: targets => targets.openTasks() },
  { kind: "case", title: "Horiace prípady", empty: "Žiadny otvorený prípad s prioritou Horí.", link: "Všetky horiace prípady", open: targets => targets.openCases("urgent") },
];
/** Full inbox; each source shows its own loading and error state. */
export function AlertsScreen({ scope, active, targets, notice }: { scope: ShellScope | null; active: boolean; targets: AlertTargets | null; notice: string | null }) {
  if (scope && targets) return <AlertsBody scope={scope} active={active} targets={targets} />;
  return <ScrollView contentContainerStyle={s.content}>
    <View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>Upozornenia</Text></View>
    <Text style={s.note}>{notice ?? "Overujem prístup k prípadom a úlohám…"}</Text>
  </ScrollView>;
}
function AlertsBody({ scope, active, targets }: { scope: ShellScope; active: boolean; targets: AlertTargets }) {
  const alerts = useAlerts(scope, active);
  const [refreshing, setRefreshing] = useState(false);
  return <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={refreshing}
    onRefresh={() => { setRefreshing(true); void alerts.refresh().finally(() => setRefreshing(false)); }} />}>
    <View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>Upozornenia</Text></View>
    <Text style={s.lead}>{alerts.loading ? "Načítavam…" : alerts.failed ? "Niektoré zdroje sa nepodarilo načítať; zoznam nemusí byť úplný."
      : alerts.items.length ? summary(alerts).count + " na vybavenie, najnaliehavejšie navrchu." : summary(alerts).empty?.title + "."}</Text>
    {sections.map(section => {
      const source = alerts.sources[section.kind], items = alerts.items.filter(item => item.kind === section.kind), more = alerts.more[section.kind];
      return <View key={section.kind}>
        <SectionHeader title={section.title} detail={items.length || more ? String(items.length) + (more ? "+" : "") : null} />
        {source.isPending ? <ActivityIndicator color={palette.secondaryLabel} /> : <>
          {source.isError && <View style={s.retry}><ErrorNotice message={errorText(source.error)} onRetry={() => { void source.refetch(); }} /></View>}
          <Group>
            {items.map((item, index) => <AlertRow key={item.key} item={item} first={index === 0} targets={targets} />)}
            {items.length === 0 && !source.isError && <Row first title={more ? "Na prvej stránke nič" : "Nič na vybavenie"}
              subtitle={more ? "Ďalšie položky sa nečítali. Otvorte celý zoznam." : section.empty} />}
            {/* Every section leads to its full list, also past the first page read here. */}
            <Row first={items.length === 0 && source.isError} title={section.link} tone="link" onPress={() => section.open(targets)} trailing={<Text style={s.chevron}>›</Text>} />
          </Group>
        </>}
      </View>;
    })}
    <Text style={s.note}>Vychádza z prvej stránky spätných volaní, vašich otvorených úloh a horiacich prípadov celej organizácie. Obnovuje sa každú minútu.</Text>
  </ScrollView>;
}

const s = StyleSheet.create({
  content: { paddingBottom: NAVIGATION_CONTENT_BOTTOM },
  titleRow: { paddingHorizontal: space.l, paddingTop: 2 },
  title: { ...type.title, color: palette.label },
  lead: { ...type.subhead, color: palette.secondaryLabel, paddingHorizontal: space.l, paddingTop: 2 },
  note: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 20, paddingTop: space.s },
  icon: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: space.m, paddingVertical: 8, minHeight: 56, backgroundColor: palette.card },
  separator: { position: "absolute", top: 0, left: 50, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  rowTitle: { ...type.rowTitle, color: palette.label },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 6, overflow: "hidden" },
  rowDetail: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, flexShrink: 1 },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
  retry: { paddingHorizontal: space.l, paddingBottom: space.s },
});
