import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MobileCaseDetailData, MobileCaseFilter, MobileCaseNoteAdded, MobileCaseSummary } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import { dialable, formatNumber, formatTime } from "../lib/display";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "../ui";
import type { CasesApi } from "./api";
import { CaseDraft, type DraftState } from "./draft";
import { randomUUID } from "expo-crypto";
import { CaseEdit } from "./edit";
import { CaseEditor } from "./editor";
import { CaseNoteDraft } from "./notes";
import { CaseNoteForm, CaseNoteSavedNotice } from "./note-editor";
import { directionsUrl } from "./maps";
import { Choice, fields, jobTypes, priorities } from "./form";
import { WorkStore } from "../work/store";
import { Attachments } from "../work/attachments-ui";
import { Tasks } from "../work/tasks-ui";

const errorMessage = (error: unknown) => error instanceof MobileApiError ? error.message : "Prípady sa nepodarilo načítať. Skúste znova.";
type Page = { kind: "attachments"; id: string } | { kind: "tasks"; id: string } | { kind: "list" } | { kind: "new" } | { kind: "detail"; id: string; note?: CaseNoteDraft } | { kind: "edit"; id: string; edit: CaseEdit } | { kind: "note"; id: string; draft: CaseNoteDraft };

/** Kept mounted under the authenticated workspace across tab changes. Reads
 * pause when hidden; unsaved input and a confirmed created ID stay in memory. */
export function Cases({ api, environment, userId, profileId, active, onSelectNumber }: {
  api: CasesApi; environment: string; userId: string; profileId: string; active: boolean; onSelectNumber: (number: string) => void;
}) {
  const queryClient = useQueryClient();
  const prefix = useMemo(() => ["mobile", environment, userId, "cases", profileId], [environment, userId, profileId]);
  const work = useMemo(() => new WorkStore(api.work, () => { void queryClient.invalidateQueries({ queryKey: prefix }); }), [api.work, queryClient, prefix]);
  useEffect(() => () => work.dispose(), [work]);
  const notes = useRef(new Map<string, CaseNoteDraft>());
  const edits = useRef(new Map<string, CaseEdit>());
  const draft = useMemo(() => new CaseDraft(api), [api]);
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  const [page, setPage] = useState<Page>({ kind: "list" });
  const [ownership, setOwnership] = useState<MobileCaseFilter["ownership"]>("all");
  const [category, setCategory] = useState<MobileCaseFilter["category"]>("open");
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  useEffect(() => { const retained = edits.current; return () => { for (const edit of retained.values()) edit.dispose(); }; }, []);
  useEffect(() => { const retained = notes.current; return () => { for (const note of retained.values()) note.dispose(); }; }, []);
  const edited = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...prefix, "list"] });
    void queryClient.invalidateQueries({ queryKey: [...prefix, "detail"] });
  }, [queryClient, prefix]);
  function showDetail(id: string) { setPage({ kind: "detail", id, note: notes.current.get(id) }); }
  function openEditor(item: MobileCaseDetailData) {
    const previous = edits.current.get(item.id);
    if (!previous || previous.snapshot().status === "saved") { previous?.dispose(); edits.current.set(item.id, new CaseEdit(api, item, randomUUID)); }
    setPage({ kind: "edit", id: item.id, edit: edits.current.get(item.id)! });
  }
  function openNote(id: string) {
    let note = notes.current.get(id);
    if (!note) { note = new CaseNoteDraft(api, id); notes.current.set(id, note); }
    note.newNote(); setPage({ kind: "note", id, draft: note });
  }
  function noteUpdated(receipt: MobileCaseNoteAdded) {
    void queryClient.invalidateQueries({ queryKey: [...prefix, "detail", receipt.caseId] });
    void queryClient.invalidateQueries({ queryKey: [...prefix, "list"] });
  }
  function noteSaved(receipt: MobileCaseNoteAdded) {
    noteUpdated(receipt); showDetail(receipt.caseId);
  }
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
      showDetail(created.caseId);
      void queryClient.invalidateQueries({ queryKey: [...prefix, "list"] });
    }
  }
  function showList() {
    setPage({ kind: "list" });
    if (state.status === "uncertain") {
      // A newly created draft belongs to this operator but may not match the
      // previous owner, status or search filter. Review all of their cases first.
      setOwnership("mine"); setOwnerId(null); setCategory("all"); setSearch("");
      void queryClient.invalidateQueries({ queryKey: [...prefix, "list"] });
    }
  }
  function showForm() { draft.newDraft(); setPage({ kind: "new" }); }
  return <View style={{ flex: 1 }}>
    {page.kind === "attachments" ? <Attachments store={work} caseId={page.id} queryKey={prefix} active={active} onBack={() => showDetail(page.id)} />
      : page.kind === "tasks" ? <Tasks store={work} caseId={page.id} queryKey={prefix} profileId={profileId} active={active} onBack={() => showDetail(page.id)} />
      : page.kind === "list" ? <CaseList api={api} queryKey={prefix} active={active} ownership={ownership} category={category}
      search={search} ownerId={ownerId} onSearch={setSearch} onOwnership={value => { setOwnership(value); setOwnerId(null); }}
      onOwner={id => { setOwnership("all"); setOwnerId(id); }} onCategory={setCategory} onOpen={showDetail}
      onNew={showForm} draftState={state} onReviewed={requestedAt => draft.reviewList(requestedAt)} />
      : page.kind === "new" ? <CaseForm draft={draft} state={state} onBack={showList} onSubmit={() => { void save(); }} />
        : page.kind === "edit" ? <CaseEditor edit={page.edit} active={active} onSaved={edited} onBack={() => showDetail(page.id)} />
        : page.kind === "note" ? <CaseNoteForm draft={page.draft} onSaved={noteSaved} onBack={() => showDetail(page.id)} />
        : <CaseDetail api={api} queryKey={prefix} active={active} id={page.id} created={state.created?.caseId === page.id ? state.created : null}
          onBack={showList} onAttachments={() => setPage({ kind: "attachments", id: page.id })} onTasks={() => setPage({ kind: "tasks", id: page.id })} onSelectNumber={onSelectNumber} onEdit={openEditor} onNote={openNote} savedNote={page.note} onNoteUpdated={noteUpdated} />}
  </View>;
}

function CaseList({ api, queryKey, active, ownership, category, search, ownerId, onOwner, onSearch, onOwnership, onCategory, onOpen, onNew, draftState, onReviewed }: {
  api: CasesApi; queryKey: string[]; active: boolean; ownership: MobileCaseFilter["ownership"]; category: MobileCaseFilter["category"]; search: string; ownerId: string | null; onOwner: (id: string | null) => void;
  onSearch: (value: string) => void; onOwnership: (value: MobileCaseFilter["ownership"]) => void; onCategory: (value: MobileCaseFilter["category"]) => void;
  onOpen: (id: string) => void; onNew: () => void; draftState: DraftState; onReviewed: (requestedAt: number) => void;
}) {
  const [selectingOwner, setSelectingOwner] = useState(false);
  const dispatchers = useQuery({ queryKey: [...queryKey, "dispatchers"], queryFn: ({ signal }) => api.dispatchers(signal), enabled: active && (selectingOwner || ownerId !== null) });
  const selectedOwner = dispatchers.isError ? undefined : dispatchers.data?.dispatchers.find(item => item.id === ownerId);
  const [debounced, setDebounced] = useState(search.trim());
  useEffect(() => { const timer = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  const query = useInfiniteQuery({
    queryKey: [...queryKey, "list", ownership, ownerId, category, debounced], enabled: active,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.list({ ownership, ownerId, category, q: debounced, cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const pendingSearch = search.trim() !== debounced;
  const denied = query.error instanceof MobileApiError && [401, 403, 409, 502].includes(query.error.status);
  const canShow = !pendingSearch && !denied && !(query.isError && !query.isFetchNextPageError);
  useEffect(() => {
    if (active && canShow && query.isSuccess && !query.isFetching && ownership === "mine" && !ownerId && category === "all" && !debounced) onReviewed(query.data?.pages[0]?.requestedAt ?? 0);
  }, [active, canShow, query.isSuccess, query.isFetching, query.data, ownership, ownerId, category, debounced, onReviewed]);
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
      <Choice label="Všetkých" selected={ownership === "all" && ownerId === null} onPress={() => onOwnership("all")} />
    </View>
    <Button label={ownerId ? "Dispečer: " + (selectedOwner ? selectedOwner.name + (selectedOwner.active ? "" : " (neaktívny)") : "Vybraný dispečer") : "Vybrať dispečera"}
      secondary onPress={() => { Keyboard.dismiss(); setSelectingOwner(true); }} />
    <Modal visible={active && selectingOwner} transparent animationType="fade" onRequestClose={() => setSelectingOwner(false)}>
      <View style={s.modalBackdrop}><View accessibilityViewIsModal style={s.modalCard}>
        <Text style={styles.subheading}>Vybrať dispečera</Text>
        <Button label="Zavrieť výber" secondary onPress={() => setSelectingOwner(false)} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
          <Choice label="Všetci dispečeri" selected={ownership === "all" && ownerId === null} onPress={() => { onOwner(null); setSelectingOwner(false); }} />
          {dispatchers.isPending ? <Loading /> : dispatchers.isError ? <ErrorNotice message={errorMessage(dispatchers.error)} onRetry={() => { void dispatchers.refetch(); }} />
            : dispatchers.data?.dispatchers.map(item => <Choice key={item.id} label={item.name + (item.active ? "" : " (neaktívny)")} selected={ownerId === item.id}
              onPress={() => { onOwner(item.id); setSelectingOwner(false); }} />)}
        </ScrollView>
      </View></View>
    </Modal>
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
function CaseDetail({ api, queryKey, active, id, created, onBack, onAttachments, onTasks, onSelectNumber, onEdit, onNote, savedNote, onNoteUpdated }: {
  api: CasesApi; queryKey: string[]; active: boolean; id: string; created: DraftState["created"]; onBack: () => void; onAttachments: () => void; onTasks: () => void; onSelectNumber: (number: string) => void; onEdit: (item: MobileCaseDetailData) => void; onNote: (id: string) => void; savedNote?: CaseNoteDraft; onNoteUpdated: (receipt: MobileCaseNoteAdded) => void;
}) {
  const query = useQuery({ queryKey: [...queryKey, "detail", id], queryFn: ({ signal }) => api.detail(id, signal), enabled: active });
  const item = query.isError ? null : query.data?.case;
  return <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => { void query.refetch(); }} />}>
    <Button label="Späť na prípady" onPress={onBack} secondary />
    {savedNote && <CaseNoteSavedNotice draft={savedNote} onUpdated={onNoteUpdated} />}
    {created && <Card><Text accessibilityRole="alert" style={styles.subheading}>Prípad {created.caseNumber} je uložený.</Text>
      {created.warnings.map((warning, index) => <Text key={warning.code + index} style={styles.text}>{warning.message}</Text>)}</Card>}
    {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} />
      : item && <><Button label="Upraviť prípad" onPress={() => onEdit(item)} /><Button label="Pridať poznámku" secondary onPress={() => onNote(item.id)} /><Button label="Prílohy prípadu" secondary onPress={onAttachments} /><Button label="Úlohy prípadu" secondary onPress={onTasks} /><Card><CaseHeading item={item} /><Text style={styles.muted}>{item.owner.mine ? "Môj prípad" : item.owner.name || "Bez vlastníka"} · {formatTime(item.createdAt)}</Text></Card>
        <Card><Info label="Kontakt" value={item.contact.name} /><Info label="Telefón" value={item.contact.phone ? formatNumber(item.contact.phone) : null} />
          {dialable(item.contact.phone) && <Button label="Vybrať číslo v ústredni" onPress={() => { if (item.contact.phone) onSelectNumber(item.contact.phone); }} secondary />}</Card>
        <Card><Info label="EČV" value={item.vehicle.licensePlate} /><Info label="Vozidlo" value={item.vehicle.description} /><Info label="Služba" value={item.jobTypeLabels.join(", ")} /></Card>
        <Card><Info label="Vyzdvihnutie" value={item.pickupAddress} /><Info label="Cieľ" value={item.destinationAddress} />
          <Navigate label="Navigovať na vyzdvihnutie" address={item.pickupAddress} /><Navigate label="Navigovať do cieľa" address={item.destinationAddress} /></Card>
        <Card><Info label="Problém" value={item.incidentDescription || item.summary} /><Info label="Poznámka" value={item.mainNote} /></Card>
        <Text style={styles.subheading}>Posledné udalosti</Text>
        {item.timeline.length === 0 && <Text style={styles.muted}>Zatiaľ bez udalostí.</Text>}
        {item.timeline.map(event => <Card key={event.id}><Text style={styles.label}>{event.title}</Text>{Boolean(event.body) && <Text selectable style={styles.text}>{event.body}</Text>}
          <Text style={styles.muted}>{formatTime(event.createdAt)}{event.actorName ? " · " + event.actorName : ""}</Text></Card>)}
      </>}
  </ScrollView>;
}
function Navigate({ label, address }: { label: string; address: string | null }) {
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  if (!address?.trim()) return null;
  return <View style={{ gap: 8 }}><Button label={label} secondary disabled={busy} onPress={() => {
    setBusy(true); setError(null);
    void (async () => {
      try { await Linking.openURL(directionsUrl(address)); }
      catch (error) { setError(error instanceof Error && error.message.startsWith("Adresa") ? error.message : "Navigáciu sa nepodarilo otvoriť. Skúste znova."); }
      finally { setBusy(false); }
    })();
  }} />{error && <ErrorNotice message={error} />}</View>;
}
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
  modalBackdrop: { flex: 1, justifyContent: "center", padding: 20, backgroundColor: "rgba(0,0,0,0.5)" },
  modalCard: { maxHeight: "80%", backgroundColor: colors.white, borderRadius: 20, padding: 20, gap: 16 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
