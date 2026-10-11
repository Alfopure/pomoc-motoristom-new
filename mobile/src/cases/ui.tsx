import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MobileCaseCreateInput, MobileCaseFilter, MobileCaseJobType, MobileCasePriority, MobileCaseSummary } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import { dialable, formatNumber, formatTime } from "../lib/display";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "../ui";
import type { CasesApi } from "./api";
import { CaseDraft, type DraftState } from "./draft";

const priorities: { value: MobileCasePriority; label: string }[] = [
  { value: "urgent", label: "Horí" }, { value: "high", label: "Vysoká" }, { value: "normal", label: "Bežná" }, { value: "low", label: "Nízka" },
];
const jobTypes: { value: MobileCaseJobType; label: string }[] = [
  { value: "tow", label: "Odťah" }, { value: "replacement_vehicle", label: "Náhradné vozidlo" },
  { value: "onsite_assistance", label: "Asistencia na mieste" }, { value: "vehicle_recovery", label: "Vyslobodenie MV" },
];
const errorMessage = (error: unknown) => error instanceof MobileApiError ? error.message : "Prípady sa nepodarilo načítať. Skúste znova.";
type Page = { kind: "list" } | { kind: "new" } | { kind: "detail"; id: string };

/** Kept mounted under the authenticated workspace across tab changes. Reads
 * pause when hidden; unsaved input and a confirmed created ID stay in memory. */
export function Cases({ api, environment, userId, profileId, active, onSelectNumber }: {
  api: CasesApi; environment: string; userId: string; profileId: string; active: boolean; onSelectNumber: (number: string) => void;
}) {
  const queryClient = useQueryClient();
  const prefix = useMemo(() => ["mobile", environment, userId, "cases", profileId], [environment, userId, profileId]);
  const draft = useMemo(() => new CaseDraft(api), [api]);
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  const [page, setPage] = useState<Page>({ kind: "list" });
  const [ownership, setOwnership] = useState<MobileCaseFilter["ownership"]>("mine");
  const [category, setCategory] = useState<MobileCaseFilter["category"]>("open");
  const [search, setSearch] = useState("");
  useEffect(() => () => draft.dispose(), [draft]);
  useEffect(() => { if (!active) void queryClient.cancelQueries({ queryKey: prefix }); }, [active, queryClient, prefix]);
  useEffect(() => {
    if (state.status === "uncertain") {
      // An earlier list request may have read before the unknown save. Its
      // response cannot count as review; start a fresh read after this failure.
      void queryClient.cancelQueries({ queryKey: [...prefix, "list"] })
        .then(() => queryClient.invalidateQueries({ queryKey: [...prefix, "list"] }));
    }
  }, [state.status, queryClient, prefix]);
  async function save() {
    const created = await draft.submit();
    if (created) {
      setPage({ kind: "detail", id: created.caseId });
      void queryClient.invalidateQueries({ queryKey: [...prefix, "list"] });
    }
  }
  function showList() {
    setPage({ kind: "list" });
    if (state.status === "uncertain") {
      // A newly created draft belongs to this operator but may not match the
      // previous search/archive filter. Review a fresh unfiltered list first.
      setOwnership("mine"); setCategory("all"); setSearch("");
      void queryClient.invalidateQueries({ queryKey: [...prefix, "list"] });
    }
  }
  function showForm() { draft.newDraft(); setPage({ kind: "new" }); }
  return <View style={{ flex: 1 }}>
    {page.kind === "list" ? <CaseList api={api} queryKey={prefix} active={active} ownership={ownership} category={category}
      search={search} onSearch={setSearch} onOwnership={setOwnership} onCategory={setCategory} onOpen={id => setPage({ kind: "detail", id })}
      onNew={showForm} draftState={state} onReviewed={requestedAt => draft.reviewList(requestedAt)} />
      : page.kind === "new" ? <CaseForm draft={draft} state={state} onBack={showList} onSubmit={() => { void save(); }} />
        : <CaseDetail api={api} queryKey={prefix} active={active} id={page.id} created={state.created?.caseId === page.id ? state.created : null}
          onBack={showList} onSelectNumber={onSelectNumber} />}
  </View>;
}

function Choice({ label, selected, onPress, disabled }: { label: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled: Boolean(disabled) }} onPress={onPress} disabled={disabled}
    style={[s.choice, selected && s.selected, disabled && { opacity: 0.6 }]}>
    <Text style={[styles.muted, selected && { color: colors.white }]}>{label}</Text>
  </Pressable>;
}
function CaseList({ api, queryKey, active, ownership, category, search, onSearch, onOwnership, onCategory, onOpen, onNew, draftState, onReviewed }: {
  api: CasesApi; queryKey: string[]; active: boolean; ownership: MobileCaseFilter["ownership"]; category: MobileCaseFilter["category"]; search: string;
  onSearch: (value: string) => void; onOwnership: (value: MobileCaseFilter["ownership"]) => void; onCategory: (value: MobileCaseFilter["category"]) => void;
  onOpen: (id: string) => void; onNew: () => void; draftState: DraftState; onReviewed: (requestedAt: number) => void;
}) {
  const [debounced, setDebounced] = useState(search.trim());
  useEffect(() => { const timer = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  const query = useInfiniteQuery({
    queryKey: [...queryKey, "list", ownership, category, debounced], enabled: active,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.list({ ownership, category, q: debounced, cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const pendingSearch = search.trim() !== debounced;
  const denied = query.error instanceof MobileApiError && [401, 403, 409, 502].includes(query.error.status);
  const canShow = !pendingSearch && !denied && !(query.isError && !query.isFetchNextPageError);
  useEffect(() => {
    if (active && canShow && query.isSuccess && !query.isFetching && ownership === "mine" && category === "all" && !debounced) onReviewed(query.data?.pages[0]?.requestedAt ?? 0);
  }, [active, canShow, query.isSuccess, query.isFetching, query.data, ownership, category, debounced, onReviewed]);
  const cases = [...new Map(query.data?.pages.flatMap(page => page.cases).map(item => [item.id, item]) ?? []).values()];
  const hasDraft = draftState.status !== "saved" && Object.entries(draftState.input).some(([key, value]) =>
    key === "priority" ? value !== "normal" : Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim().length > 0);
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />}>
    <Text style={styles.heading}>Prípady</Text>
    <Button label={draftState.status === "saving" ? "Ukladanie prípadu…" : draftState.status === "uncertain" ? "Overiť uloženie prípadu" : hasDraft ? "Rozpracovaný prípad" : "Nový prípad"} onPress={onNew} />
    {draftState.status === "uncertain" && <Card><Text style={styles.text}>Skontrolujte, či sa váš prípad už uložil. Nájdete ho podľa mena, EČV alebo času vytvorenia.</Text>
      {draftState.reviewedList && <Text style={styles.muted}>Ak ho nenájdete, v rozpracovanom formulári môžete vedome povoliť opakovanie.</Text>}</Card>}
    <TextInput accessibilityLabel="Hľadať prípady" placeholder="Číslo prípadu, meno alebo EČV" placeholderTextColor={colors.muted} value={search}
      onChangeText={onSearch} maxLength={120} style={styles.input} autoCorrect={false} />
    <View style={s.choices}>
      <Choice label="Moje" selected={ownership === "mine"} onPress={() => onOwnership("mine")} />
      <Choice label="Všetkých" selected={ownership === "all"} onPress={() => onOwnership("all")} />
    </View>
    <View style={s.choices}>
      <Choice label="Otvorené" selected={category === "open"} onPress={() => onCategory("open")} />
      <Choice label="Aj uzavreté" selected={category === "all"} onPress={() => onCategory("all")} />
    </View>
    {pendingSearch || query.isPending ? <Loading /> : !canShow ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} />
      : <>{cases.length === 0 && <Card><Text style={styles.text}>Žiadne prípady pre tento výber.</Text></Card>}
        {cases.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={"Otvoriť prípad " + item.caseNumber} onPress={() => onOpen(item.id)}>
          <Card><CaseHeading item={item} /><Text style={styles.subheading}>{item.contact.name || "Kontakt bez mena"}</Text>
            <Text style={styles.text}>{[item.vehicle.licensePlate, item.vehicle.description].filter(Boolean).join(" · ") || "Vozidlo nedoplnené"}</Text>
            <Text style={styles.muted}>{item.pickupAddress || "Miesto vyzdvihnutia nedoplnené"}</Text>
            {Boolean(item.summary) && <Text numberOfLines={2} style={styles.text}>{item.summary}</Text>}
            <Text style={styles.muted}>{item.owner.mine ? "Môj prípad" : item.owner.name || "Bez vlastníka"} · {formatTime(item.createdAt)}</Text>
          </Card></Pressable>)}
        {query.isFetchNextPageError && <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.fetchNextPage(); }} />}
        {query.hasNextPage && !query.isFetchNextPageError && <Button label={query.isFetchingNextPage ? "Načítavam…" : "Ďalšie prípady"} secondary disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} />}
      </>}
  </ScrollView>;
}
function CaseHeading({ item }: { item: MobileCaseSummary }) {
  return <View style={{ gap: 5 }}><Text style={styles.subheading}>{item.caseNumber}</Text>
    <Text style={[styles.muted, item.priority === "urgent" && { color: colors.danger }]}>{item.statusLabel} · {item.priorityLabel}</Text></View>;
}
function Info({ label, value }: { label: string; value: string | null }) {
  return <View><Text style={styles.label}>{label}</Text><Text selectable style={styles.text}>{value || "Nedoplnené"}</Text></View>;
}
function CaseDetail({ api, queryKey, active, id, created, onBack, onSelectNumber }: {
  api: CasesApi; queryKey: string[]; active: boolean; id: string; created: DraftState["created"]; onBack: () => void; onSelectNumber: (number: string) => void;
}) {
  const query = useQuery({ queryKey: [...queryKey, "detail", id], queryFn: ({ signal }) => api.detail(id, signal), enabled: active });
  const item = query.isError ? null : query.data?.case;
  return <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => { void query.refetch(); }} />}>
    <Button label="Späť na prípady" onPress={onBack} secondary />
    {created && <Card><Text accessibilityRole="alert" style={styles.subheading}>Prípad {created.caseNumber} je uložený.</Text>
      {created.warnings.map((warning, index) => <Text key={warning.code + index} style={styles.text}>{warning.message}</Text>)}</Card>}
    {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} />
      : item && <><Card><CaseHeading item={item} /><Text style={styles.muted}>{item.owner.mine ? "Môj prípad" : item.owner.name || "Bez vlastníka"} · {formatTime(item.createdAt)}</Text></Card>
        <Card><Info label="Kontakt" value={item.contact.name} /><Info label="Telefón" value={item.contact.phone ? formatNumber(item.contact.phone) : null} />
          {dialable(item.contact.phone) && <Button label="Vybrať číslo v ústredni" onPress={() => { if (item.contact.phone) onSelectNumber(item.contact.phone); }} secondary />}</Card>
        <Card><Info label="EČV" value={item.vehicle.licensePlate} /><Info label="Vozidlo" value={item.vehicle.description} /><Info label="Služba" value={item.jobTypeLabels.join(", ")} /></Card>
        <Card><Info label="Vyzdvihnutie" value={item.pickupAddress} /><Info label="Cieľ" value={item.destinationAddress} /></Card>
        <Card><Info label="Problém" value={item.incidentDescription || item.summary} /><Info label="Poznámka" value={item.mainNote} /></Card>
        <Text style={styles.subheading}>Posledné udalosti</Text>
        {item.timeline.length === 0 && <Text style={styles.muted}>Zatiaľ bez udalostí.</Text>}
        {item.timeline.map(event => <Card key={event.id}><Text style={styles.label}>{event.title}</Text>{Boolean(event.body) && <Text selectable style={styles.text}>{event.body}</Text>}
          <Text style={styles.muted}>{formatTime(event.createdAt)}{event.actorName ? " · " + event.actorName : ""}</Text></Card>)}
      </>}
  </ScrollView>;
}
const fields: { key: keyof Pick<MobileCaseCreateInput, "contactName" | "contactPhone" | "licensePlate" | "vehicleMake" | "vehicleModel" | "manualPickupAddress" | "manualDestinationAddress" | "incidentDescription" | "note">; label: string; max: number; multiline?: boolean }[] = [
  { key: "contactName", label: "Meno kontaktu", max: 200 }, { key: "contactPhone", label: "Telefón kontaktu", max: 64 },
  { key: "licensePlate", label: "EČV", max: 32 }, { key: "vehicleMake", label: "Značka vozidla", max: 80 }, { key: "vehicleModel", label: "Model vozidla", max: 120 },
  { key: "manualPickupAddress", label: "Miesto vyzdvihnutia", max: 500, multiline: true }, { key: "manualDestinationAddress", label: "Cieľová adresa", max: 500, multiline: true },
  { key: "incidentDescription", label: "Popis problému", max: 5000, multiline: true }, { key: "note", label: "Poznámka", max: 10000, multiline: true },
];
function CaseForm({ draft, state, onBack, onSubmit }: { draft: CaseDraft; state: DraftState; onBack: () => void; onSubmit: () => void }) {
  const saving = state.status === "saving", uncertain = state.status === "uncertain";
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}>
      <Button label="Späť na prípady" onPress={onBack} secondary /><Text style={styles.heading}>Nový prípad</Text>
      <Text style={styles.muted}>Môžete uložiť aj neúplný koncept. Údaje doplníte neskôr v dispečingu.</Text>
      {fields.map(field => <View key={field.key}><Text style={styles.label}>{field.label}</Text>
        <TextInput accessibilityLabel={field.label} value={state.input[field.key] ?? ""} onChangeText={value => draft.edit({ [field.key]: value })}
          editable={!saving} maxLength={field.max} multiline={field.multiline} keyboardType={field.key === "contactPhone" ? "phone-pad" : "default"}
          autoCapitalize={field.key === "licensePlate" ? "characters" : "sentences"} autoCorrect={field.key !== "licensePlate" && field.key !== "contactPhone"}
          style={[styles.input, field.multiline && { minHeight: 90, textAlignVertical: "top" }]} />
      </View>)}
      <View><Text style={styles.label}>Služba</Text><View style={s.choices}>{jobTypes.map(item => {
        const selected = state.input.jobTypes?.includes(item.value) === true;
        return <Choice key={item.value} label={item.label} selected={selected} disabled={saving} onPress={() => draft.edit({ jobTypes: selected
          ? state.input.jobTypes?.filter(value => value !== item.value) : [...(state.input.jobTypes ?? []), item.value] })} />;
      })}</View></View>
      <View><Text style={styles.label}>Priorita</Text><View style={s.choices}>{priorities.map(item => <Choice key={item.value} label={item.label}
        selected={state.input.priority === item.value} disabled={saving} onPress={() => draft.edit({ priority: item.value })} />)}</View></View>
      {state.error && <ErrorNotice message={state.error} />}
      {uncertain && <><Button label="Skontrolovať zoznam prípadov" onPress={onBack} secondary />
        {state.reviewedList && <Button label="Prípad som nenašiel – povoliť opakovanie" onPress={() => draft.allowRetry()} secondary />}</>}
      <Button label={saving ? "Ukladám prípad…" : "Uložiť prípad"} disabled={saving || uncertain || state.status === "saved"} onPress={() => { Keyboard.dismiss(); onSubmit(); }} />
    </ScrollView>
  </KeyboardAvoidingView>;
}
const s = StyleSheet.create({
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, minHeight: 44, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  selected: { backgroundColor: colors.ink, borderColor: colors.ink },
});
