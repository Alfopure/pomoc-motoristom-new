import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { MobileApiError, type MobileApi } from "../lib/api";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import type { DispatchPhone, PhoneState } from "./phone";

const reasons = { busy: "Práve telefonuje", wrap_up: "Dokončuje hovor", offline: "Nedostupný", no_phone: "Telefón nie je pripojený", personal_mobile: "Interné volanie nie je dostupné" };
export function ColleaguesCard({ api, profileId, queryKey, active, phone, state }: {
  api: MobileApi; profileId: string; queryKey: string[]; active: boolean; phone: DispatchPhone | null; state: PhoneState;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { const timer = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  const query = useQuery({ queryKey: [...queryKey, "voice-colleagues", profileId, debounced],
    queryFn: ({ signal }) => api.voiceColleagues(profileId, debounced, signal), enabled: active,
    staleTime: 30_000, refetchInterval: active ? 30_000 : false });
  const searching = search.trim() !== debounced;
  // A snapshot at most 60s old on receipt stays selectable for at most 30s.
  const age = query.data ? query.dataUpdatedAt - Date.parse(query.data.checkedAt) : NaN;
  const fresh = !query.isStale && Number.isFinite(age) && age >= -30_000 && age <= 60_000;
  const visible = !searching && !query.isError && fresh;
  const selected = visible ? query.data?.colleagues.find(row => row.profileId === selectedId) : undefined;
  const canCall = active && phone && state.registration === "registered" && state.microphonePermission !== "denied"
    && !state.call && !state.termination && !state.dialing && !state.cancelingAttempt && !state.retryTarget && !query.isFetching;
  return <Card>
    <Text accessibilityRole="header" style={styles.subheading}>Kolegovia</Text>
    <TextInput accessibilityLabel="Hľadať kolegu" placeholder="Meno kolegu" maxLength={80} value={search}
      onChangeText={value => { setSearch(value); setSelectedId(null); }} autoCorrect={false} style={styles.input} />
    {searching || query.isPending ? <Loading label="Hľadám kolegov…" /> : query.isError
      ? <ErrorNotice message={query.error instanceof MobileApiError ? query.error.message : "Kolegov sa nepodarilo načítať."} onRetry={() => { void query.refetch(); }} />
      : !fresh ? <ErrorNotice message="Zoznam kolegov nie je aktuálny." onRetry={() => { void query.refetch(); }} />
      : <>
        {query.data?.colleagues.length === 0 && <Text style={styles.muted}>Pre tento výber sa nenašiel žiadny kolega.</Text>}
        {query.data?.colleagues.map(row => <View key={row.profileId} style={{ gap: 6 }}>
          <Text style={styles.label}>{row.displayName}</Text>
          <Text style={styles.muted}>{row.reason ? reasons[row.reason] : row.status === "paused" ? "Pauza · interný hovor je dostupný" : "Dostupný"}</Text>
          <Button label={(row.profileId === selectedId ? "Vybraný: " : "Vybrať: ") + row.displayName}
            secondary disabled={!active || !row.canCall || query.isFetching} onPress={() => setSelectedId(row.profileId)} />
        </View>)}
        {query.data?.hasMore && <Text style={styles.muted}>Zobrazených je prvých 50 kolegov. Spresnite vyhľadávanie.</Text>}
      </>}
    {selected && <View style={{ gap: 8 }}>
      <Text style={styles.text}>Interný hovor: {selected.displayName}</Text>
      <Button label="Zavolať kolegovi" disabled={!canCall || !selected.canCall}
        onPress={() => { if (canCall && selected.canCall) void phone?.dialColleague(selected.profileId, selected.displayName); }} />
    </View>}
    <Button label={query.isFetching ? "Obnovujem kolegov…" : "Obnoviť kolegov"} secondary disabled={!active || query.isFetching} onPress={() => { void query.refetch(); }} />
  </Card>;
}
