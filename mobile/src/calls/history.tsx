import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowDownLeft, ArrowUpRight, Phone, PhoneForwarded, Search } from "lucide-react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { MobileMe } from "../../../src/lib/mobile-api";
import type { MobileCallContextTarget } from "../../../src/lib/mobile-call-context";
import { MobileApiError, type MobileApi } from "../lib/api";
import { callStatus, dialable, formatNumber, formatTime } from "../lib/display";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "../ui";
import { palette, type } from "../design/tokens";
import { callbackStatusLabels } from "../callbacks/model";

export type HistoryCategory = "all" | "missed" | "received" | "outbound";
const categories: { id: HistoryCategory; label: string }[] = [
  { id: "all", label: "Všetky" }, { id: "missed", label: "Zmeškané" },
  { id: "received", label: "Prijaté" }, { id: "outbound", label: "Odchádzajúce" },
];
const errorMessage = (error: unknown) => error instanceof MobileApiError ? error.message : "Údaje sa nepodarilo načítať. Skúste znova.";

/** História inside the Hovory module; selecting a number never starts a call. */
export function History({ api, me, queryKey, active, category, onCategory, search, onSearch, onSelect, onCallContext }: {
  api: MobileApi; me: MobileMe; queryKey: string[]; active: boolean; category: HistoryCategory; onCategory: (value: HistoryCategory) => void;
  search: string; onSearch: (value: string) => void; onSelect: (number: string) => void; onCallContext: (target: MobileCallContextTarget) => void;
}) {
  const [debounced, setDebounced] = useState(search.trim());
  useEffect(() => { const timer = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  const query = useInfiniteQuery({
    queryKey: [...queryKey, "history", me.profileId, category, debounced], enabled: active,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.history(me.profileId, { category, q: debounced, cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const pendingSearch = search.trim() !== debounced;
  const denied = query.error instanceof MobileApiError && [401, 403, 409, 502].includes(query.error.status);
  const showCalls = !pendingSearch && !denied && !(query.isError && !query.isFetchNextPageError);
  const calls = [...new Map(query.data?.pages.flatMap(page => page.calls).map(call => [call.id, call]) ?? []).values()];
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />}>
    <View style={s.search}><Search size={16} color={colors.muted} accessible={false} />
      <TextInput accessibilityLabel="Hľadať hovory" placeholder="Číslo alebo meno" placeholderTextColor={colors.muted} value={search} onChangeText={onSearch} maxLength={160}
        style={s.searchInput} autoCorrect={false} selectionColor={colors.brand} returnKeyType="search" /></View>
    <View style={s.filters}>{categories.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === category }}
      hitSlop={{ top: 6, bottom: 6 }} onPress={() => onCategory(item.id)} style={({ pressed }) => [s.filter, item.id === category && s.filterSelected, pressed && { opacity: 0.75 }]}>
      <Text style={[s.filterText, item.id === category && { color: colors.white }]}>{item.label}</Text></Pressable>)}</View>
    {pendingSearch || query.isPending ? <Loading /> : query.isError && !query.isFetchNextPageError || denied ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} />
      : showCalls && <>{calls.length === 0 && <Card><Text style={styles.text}>Žiadne hovory pre tento výber.</Text></Card>}
        {calls.length > 0 && <View style={s.group}>{calls.map((call, index) => {
          const DirectionIcon = call.direction === "outbound" ? ArrowUpRight : call.direction === "internal" ? Phone : ArrowDownLeft;
          const missed = call.status === "missed", title = call.name || formatNumber(call.number);
          const duration = call.durationSeconds === null ? null : Math.floor(call.durationSeconds / 60) + ":" + String(Math.floor(call.durationSeconds % 60)).padStart(2, "0");
          const callback = call.callback ? "Spätné: " + callbackStatusLabels[call.callback.status] + (call.callback.status === "scheduled" && call.callback.claimedByName ? " · " + call.callback.claimedByName : "") : null;
          return <View key={call.id} style={s.row}>
            {index > 0 && <View style={s.separator} />}
            <Pressable accessibilityRole="button" accessibilityLabel={"Detail hovoru " + title} onPress={() => onCallContext({ kind: "call", id: call.id })}
              style={({ pressed }) => [s.rowMain, pressed && { opacity: 0.6 }]}>
              <View style={[s.callIcon, missed && s.missedIcon]}><DirectionIcon size={16} strokeWidth={2.2} color={missed ? colors.danger : colors.ink} accessible={false} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={s.titleLine}><Text numberOfLines={1} style={[s.callTitle, missed && { color: colors.danger }]}>{title}</Text><Text style={s.time}>{formatTime(call.startedAt)}</Text></View>
                <Text numberOfLines={1} style={s.callSub}>{[call.name ? formatNumber(call.number) : null, call.direction === "outbound" ? "Odchádzajúci" : call.direction === "internal" ? "Interný" : "Prichádzajúci", callStatus(call.status), duration].filter(Boolean).join(" · ")}</Text>
                <Text numberOfLines={1} style={[s.callMeta, call.callback?.status === "open" && { color: colors.danger }]}>{[call.lineLabel, callback].filter(Boolean).join(" · ")}</Text>
              </View>
            </Pressable>
            {call.direction !== "internal" && dialable(call.number) && <Pressable accessibilityRole="button" accessibilityLabel={"Vybrať číslo " + formatNumber(call.number) + " na volanie"} hitSlop={6}
              onPress={() => { if (call.number) onSelect(call.number); }} style={({ pressed }) => [s.select, pressed && { opacity: 0.6 }]}>
              <PhoneForwarded size={17} strokeWidth={2.2} color={colors.ink} accessible={false} /></Pressable>}
          </View>;
        })}</View>}
        {calls.length > 0 && <Text style={styles.muted}>Ťuknutím otvoríte detail hovoru, ikonou vpravo vyberiete číslo na volanie.</Text>}
        {query.isFetchNextPageError && <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.fetchNextPage(); }} />}
        {query.hasNextPage && !query.isFetchNextPageError && <Button label={query.isFetchingNextPage ? "Načítavam…" : "Ďalšie hovory"} secondary disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} />}
      </>}
  </ScrollView>;
}
const s = StyleSheet.create({
  search: { minHeight: 38, borderRadius: 19, backgroundColor: palette.fill, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12 },
  searchInput: { flex: 1, minHeight: 38, fontSize: 16, color: colors.ink, paddingVertical: 0 },
  group: { backgroundColor: colors.white, borderRadius: 16, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", paddingRight: 8 },
  separator: { position: "absolute", top: 0, left: 50, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  rowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 12, paddingVertical: 8, minHeight: 56 },
  callIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  missedIcon: { backgroundColor: palette.redSoft },
  titleLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  callTitle: { ...type.rowTitle, color: colors.ink, flex: 1 },
  time: { ...type.caption, color: colors.muted, fontVariant: ["tabular-nums"] },
  callSub: { ...type.subhead, color: colors.muted },
  callMeta: { ...type.caption, fontWeight: "400", color: colors.muted },
  select: { width: 40, height: 40, borderRadius: 20, backgroundColor: palette.fill, alignItems: "center", justifyContent: "center", marginLeft: 6 },
  filters: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  filter: { borderRadius: 16, minHeight: 32, backgroundColor: palette.card, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.separator, paddingHorizontal: 12, paddingVertical: 6, alignItems: "center", justifyContent: "center" },
  filterText: { fontSize: 13, lineHeight: 17, fontWeight: "600", color: colors.ink },
  filterSelected: { backgroundColor: colors.ink, borderColor: colors.ink },
});
