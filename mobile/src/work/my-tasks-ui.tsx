import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { MobileMyTaskFilter } from "../../../src/lib/mobile-api";
import { Choice, priorities } from "../cases/form";
import { formatTime } from "../lib/display";
import { useAndroidBack } from "../lib/use-android-back";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
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
    {onLeave && <Button label="Späť na ústredňu" secondary onPress={onLeave} />}
    <Text style={styles.heading}>Moje úlohy</Text>
    <Text style={styles.muted}>Úlohy naprieč prípadmi, ktoré riešite alebo kontrolujete.</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Choice label="Priradené mne" selected={view === "assigned"} onPress={() => setView("assigned")} />
      <Choice label="Na kontrolu" selected={view === "review"} onPress={() => setView("review")} />
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Choice label="Otvorené" selected={category === "open"} onPress={() => setCategory("open")} />
      <Choice label="Aj dokončené" selected={category === "all"} onPress={() => setCategory("all")} />
    </View>
    <TextInput accessibilityLabel="Hľadať úlohu podľa názvu" placeholder="Hľadať podľa názvu úlohy" value={search} onChangeText={setSearch} maxLength={200} autoCorrect={false} style={styles.input} />
    {view === "review" && <Text style={styles.muted}>Úlohy, pri ktorých ste kontrolórom, aj keď ešte neboli odovzdané na kontrolu.</Text>}
    <Button label="Obnoviť úlohy" secondary disabled={!listActive || pendingSearch || query.isFetching} onPress={() => { void query.refetch(); }} />
    {pendingRequest || pendingSearch || query.isPending ? <Loading /> : !canShow ? <ErrorNotice message={workError(query.error)} onRetry={() => { if (query.isFetchNextPageError) void query.fetchNextPage(); else void query.refetch(); }} /> : <>
      {!items.length && <Card><Text style={styles.text}>Žiadne úlohy pre tento výber.</Text></Card>}
      {items.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={"Otvoriť úlohu " + item.title} onPress={() => setSelected(item.id)}><Card>
        <Text style={styles.subheading}>{item.title}</Text>
        <Text style={styles.text}>{workflowLabels[item.workflowState]} · {priorities.find(value => value.value === item.priority)?.label}</Text>
        <Text style={styles.muted}>{item.assignedTo?.name ?? "Nepriradená"}{item.dueAt ? " · " + formatTime(item.dueAt) : ""}</Text>
        {item.reviewer && <Text style={styles.muted}>Kontrolór: {item.reviewer.name}</Text>}
      </Card></Pressable>)}
      {query.hasNextPage && <Button label="Ďalšie úlohy" secondary disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} />}
    </>}
  </ScrollView>;
}
