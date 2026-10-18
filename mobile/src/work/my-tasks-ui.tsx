import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { RotateCw, Search } from "lucide-react-native";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { MobileMyTaskFilter } from "../../../src/lib/mobile-api";
import { Choice, priorities } from "../cases/form";
import { formatTime } from "../lib/display";
import { useAndroidBack } from "../lib/use-android-back";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "../ui";
import type { WorkStore } from "./store";
import { TaskDetail } from "./tasks-ui";
import { workflowLabels, workError } from "./ui-shared";

type Props = {
  store: WorkStore;
  queryKey: string[];
  profileId: string;
  active: boolean;
  onOpenCase?: (id: string) => void;
  onLeave?: () => void;
  openTaskRequest?: { taskId: string; nonce: number };
};

/** Root keeps this account-scoped screen mounted across tab changes. */
export function MyTasks(props: Props) {
  return <MyTasksWorkspace key={JSON.stringify([...props.queryKey, props.profileId])} {...props} />;
}

function MyTasksWorkspace({ store, queryKey, profileId, active, onOpenCase, onLeave, openTaskRequest }: Props) {
  const client = useQueryClient();
  const prefix = useMemo(() => [...queryKey, "my-tasks", profileId], [queryKey, profileId]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<MobileMyTaskFilter["view"]>("assigned");
  const [category, setCategory] = useState<MobileMyTaskFilter["category"]>("open");
  const [search, setSearch] = useState("");
  const [q, setQuery] = useState("");
  const [handledRequest, setHandledRequest] = useState<string | null>(null);
  const requestedId = openTaskRequest?.taskId;
  const requestKey = requestedId && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(requestedId) ? JSON.stringify([requestedId, openTaskRequest.nonce]) : null;
  const pendingRequest = requestKey !== null && requestKey !== handledRequest;
  if (pendingRequest && requestedId) {
    setHandledRequest(requestKey);
    setView("assigned"); setCategory("open"); setSearch(""); setQuery(""); setSelected(requestedId);
  }
  useEffect(() => {
    if (requestKey) void client.cancelQueries({ queryKey: [...prefix, "list"] });
  }, [requestKey, client, prefix]);
  const pendingSearch = search.trim() !== q;
  const listActive = active && selected === null && !pendingRequest;
  useAndroidBack(listActive && !!onLeave, () => onLeave?.());
  useEffect(() => {
    if (!listActive) return;
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search, listActive]);
  useEffect(() => {
    if (!active) void client.cancelQueries({ queryKey: prefix });
  }, [active, client, prefix]);
  useEffect(() => () => { void client.cancelQueries({ queryKey: prefix }); }, [client, prefix]);
  const key = [...prefix, "list", view, category, q];
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: listActive && !pendingSearch,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => store.api.myTasks({ view, category, q, cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  useEffect(() => {
    if (!listActive || pendingSearch) void client.cancelQueries({ queryKey: [...prefix, "list"] });
  }, [listActive, pendingSearch, client, prefix]);
  if (selected) return <TaskDetail key={selected} store={store} taskId={selected} queryKey={prefix} profileId={profileId} active={active} onBack={() => setSelected(null)} onOpenCase={onOpenCase} />;
  const items = [...new Map(query.data?.pages.flatMap(page => page.tasks).map(item => [item.id, item]) ?? []).values()];
  const canShow = !pendingRequest && !pendingSearch && !query.isError;
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { if (listActive && !pendingSearch) void query.refetch(); }} />}>
    <Text style={styles.heading}>Moje úlohy</Text>
    <Text style={styles.muted}>Úlohy naprieč prípadmi, ktoré riešite alebo kontrolujete.</Text>
    <View style={s.search}><Search size={16} color={colors.muted} accessible={false} />
      <TextInput accessibilityLabel="Hľadať úlohu podľa názvu" placeholder="Hľadať podľa názvu úlohy" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} maxLength={200} autoCorrect={false} style={s.searchInput} returnKeyType="search" />
      <Pressable accessibilityRole="button" accessibilityLabel="Obnoviť úlohy" accessibilityState={{ disabled: !listActive || pendingSearch || query.isFetching }} hitSlop={8}
        disabled={!listActive || pendingSearch || query.isFetching} onPress={() => { void query.refetch(); }} style={({ pressed }) => [s.refresh, pressed && { opacity: 0.6 }]}>
        <RotateCw size={16} strokeWidth={2.2} color={!listActive || pendingSearch || query.isFetching ? colors.border : colors.ink} accessible={false} /></Pressable>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Choice label="Priradené mne" selected={view === "assigned"} onPress={() => setView("assigned")} />
      <Choice label="Na kontrolu" selected={view === "review"} onPress={() => setView("review")} />
      <Choice label="Otvorené" selected={category === "open"} onPress={() => setCategory("open")} />
      <Choice label="Aj dokončené" selected={category === "all"} onPress={() => setCategory("all")} />
    </View>
    {view === "review" && <Text style={styles.muted}>Úlohy, pri ktorých ste kontrolórom, aj keď ešte neboli odovzdané na kontrolu.</Text>}
    {pendingRequest || pendingSearch || query.isPending ? <Loading /> : !canShow ? <ErrorNotice message={workError(query.error)} onRetry={() => { if (query.isFetchNextPageError) void query.fetchNextPage(); else void query.refetch(); }} /> : <>
      {!items.length && <Card><Text style={styles.text}>Žiadne úlohy pre tento výber.</Text></Card>}
      {items.length > 0 && <View style={s.group}>{items.map((item, index) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={"Otvoriť úlohu " + item.title} onPress={() => setSelected(item.id)}
        style={({ pressed }) => [s.row, pressed && { backgroundColor: "#ECECF0" }]}>
        {index > 0 && <View style={s.separator} />}
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View style={s.titleLine}><Text numberOfLines={1} style={s.title}>{item.title}</Text>{item.dueAt && <Text style={s.due}>{formatTime(item.dueAt)}</Text>}</View>
          <Text numberOfLines={1} style={styles.muted}>{workflowLabels[item.workflowState]} · {priorities.find(value => value.value === item.priority)?.label}</Text>
          <Text numberOfLines={1} style={s.meta}>{[item.assignedTo?.name ?? "Nepriradená", item.reviewer ? "Kontrolór: " + item.reviewer.name : null].filter(Boolean).join(" · ")}</Text>
        </View>
        <Text style={s.chevron}>›</Text>
      </Pressable>)}</View>}
      {query.hasNextPage && <Button label="Ďalšie úlohy" secondary disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} />}
    </>}
  </ScrollView>;
}
const s = StyleSheet.create({
  search: { minHeight: 38, borderRadius: 19, backgroundColor: "rgba(118,118,128,0.12)", flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 12, paddingRight: 4 },
  searchInput: { flex: 1, minHeight: 38, fontSize: 16, color: colors.ink, paddingVertical: 0 },
  refresh: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  group: { backgroundColor: colors.white, borderRadius: 16, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 8, minHeight: 60 },
  separator: { position: "absolute", top: 0, left: 12, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: "rgba(60,60,67,0.16)" },
  titleLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "600", color: colors.ink, flex: 1 },
  due: { fontSize: 12, lineHeight: 16, fontWeight: "500", color: colors.muted, fontVariant: ["tabular-nums"] },
  meta: { fontSize: 12, lineHeight: 16, color: colors.muted },
  chevron: { fontSize: 20, color: "#AEAEB2" },
});
