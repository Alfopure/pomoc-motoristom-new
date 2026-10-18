import { usePhoneOverlay } from "../ui/phone-overlays";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Search } from "lucide-react-native";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAndroidBack } from "../lib/use-android-back";
import type { MobileCaseDetailData, MobileCaseFilter, MobileCaseNoteAdded, MobileCaseSummary } from "../../../src/lib/mobile-api";
import { isClosedCaseStatus } from "../../../src/lib/mobile-case-filters";
import { caseShortcut, caseRecoverySelection, canReviewCaseCreation, statusForCategory, type CaseSelection, type CaseShortcut } from "./filters";
import { CaseFilterControls } from "./filter-controls";
import { CaseOverview } from "./overview";
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
import { CaseOwnerDraft } from "./owner";
import { CaseOwnerForm } from "./owner-ui";
import { CasePlacePicker } from "./case-place-picker";
import { CaseMapFrame } from "./map-frame";
import { CopyValue } from "./copy";
import { directionsUrl } from "./maps";
import { Choice, MenuChip, fields, jobTypes, priorities } from "./form";
import { HandoffDraft } from "../handoff/draft";
import { Handoffs } from "../handoff/ui";
import { WorkStore } from "../work/store";
import { Attachments } from "../work/attachments-ui";
import { Tasks } from "../work/tasks-ui";
import type { DraftVault } from "../drafts/vault";
import { draftId } from "../drafts/port";
import { customerCallNumber } from "../call-context/number";
import { CallPhoneOffer } from "./call-phone-offer";

const errorMessage = (error: unknown) => error instanceof MobileApiError ? error.message : "Prípady sa nepodarilo načítať. Skúste znova.";
export type CaseOpenRequest = ({ kind: "case.owner" | "detail" | "case-create" | "case-edit" | "case-note" | "task-create" | "handoff" | "attachment"; id: string | null } | { kind: "case-call-create"; id: null; number: string }) & { nonce: number };
type CallOffer = { number: string; nonce: number };
type Page = { kind: "case.owner"; id: string; draft: CaseOwnerDraft } | { kind: "resume-edit"; id: string; nonce: number; initialError?: string; normalEntry?: boolean } | { kind: "handoffs"; id: string; draft: HandoffDraft } | { kind: "attachments"; id: string } | { kind: "tasks"; id: string; nonce?: number } | { kind: "list" } | { kind: "new"; callOffer?: CallOffer } | { kind: "detail"; id: string; note?: CaseNoteDraft } | { kind: "edit"; id: string; edit: CaseEdit } | { kind: "note"; id: string; draft: CaseNoteDraft };

/** Kept mounted under the authenticated workspace across tab changes. Reads
 * pause when hidden; unsaved input and a confirmed created ID stay in memory. */
export function Cases({ api, environment, userId, profileId, active, visible = active, onSelectNumber, onLeaveCases, workStore, vault, queryKey, openRequest }: {
  api: CasesApi; environment: string; userId: string; profileId: string; active: boolean; visible?: boolean; onSelectNumber: (number: string) => void; onLeaveCases?: () => void;
  workStore?: WorkStore; vault?: DraftVault; queryKey?: string[]; openRequest?: CaseOpenRequest;
}) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState<Page>({ kind: "list" });
  const prefix = useMemo(() => queryKey ?? ["mobile", environment, userId, "cases", profileId], [queryKey, environment, userId, profileId]);
  const work = useMemo(() => workStore ?? new WorkStore(
    api.work,
    () => { void queryClient.invalidateQueries({ queryKey: prefix }); },
    vault ? (kind, id) => vault.bind(kind, id) : undefined
  ), [workStore, api.work, queryClient, prefix, vault]);
  useEffect(() => () => {
    if (!workStore) work.dispose();
  }, [work, workStore]);
  const handoffs = useRef(new Map<string, HandoffDraft>());
  useEffect(() => { const retained = handoffs.current; return () => { for (const draft of retained.values()) draft.dispose(); }; }, []);
  const openHandoffs = useCallback((id: string) => {
    let draft = handoffs.current.get(id);
    if (!draft) {
      draft = new HandoffDraft(
        api.handoffs, id, randomUUID,
        () => { void queryClient.invalidateQueries({ queryKey: prefix }); },
        vault?.bind("handoff", id)
      );
      handoffs.current.set(id, draft);
    }
    setPage({ kind: "handoffs", id, draft });
  }, [api.handoffs, queryClient, prefix, vault]);
  const owners = useRef(new Map<string, CaseOwnerDraft>());
  useEffect(() => { const retained = owners.current; return () => { for (const draft of retained.values()) draft.dispose(); }; }, []);
  const openOwner = useCallback((id: string) => {
    let owner = owners.current.get(id);
    if (!owner) { owner = new CaseOwnerDraft(api, id, randomUUID, vault?.bind("case.owner", id)); owners.current.set(id, owner); }
    setPage({ kind: "case.owner", id, draft: owner });
  }, [api, vault]);
  const notes = useRef(new Map<string, CaseNoteDraft>());
  const edits = useRef(new Map<string, CaseEdit>());
  const draft = useMemo(() => new CaseDraft(api, vault?.bind("case-create")), [api, vault]);
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  const [ownership, setOwnership] = useState<MobileCaseFilter["ownership"]>("all");
  const [category, setCategory] = useState<MobileCaseFilter["category"]>("open");
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<MobileCaseFilter["status"]>(null);
  const [priority, setPriority] = useState<MobileCaseFilter["priority"]>(null);
  const selectFilters = useCallback((selection: CaseSelection) => {
    setOwnership(selection.ownership); setOwnerId(selection.ownerId ?? null); setCategory(selection.category);
    setSearch(selection.q); setStatus(selection.status ?? null); setPriority(selection.priority ?? null);
  }, []);
  useEffect(() => { const retained = edits.current; return () => { for (const edit of retained.values()) edit.dispose(); }; }, []);
  useEffect(() => { const retained = notes.current; return () => { for (const note of retained.values()) note.dispose(); }; }, []);
  const edited = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...prefix, "list"] });
    void queryClient.invalidateQueries({ queryKey: [...prefix, "detail"] });
    void queryClient.invalidateQueries({ queryKey: [...prefix, "overview"] });
  }, [queryClient, prefix]);
  const showDetail = useCallback((id: string) => { setPage({ kind: "detail", id, note: notes.current.get(id) }); }, []);
  const openEditor = useCallback((item: MobileCaseDetailData, resume = false) => {
    let edit = edits.current.get(item.id);
    if (!edit) {
      edit = new CaseEdit(api, item, randomUUID, vault?.bind("case-edit", item.id));
      edits.current.set(item.id, edit);
    } else edit.observeFreshSource(item);
    if (!resume) edit.newEdit(item);
    setPage({ kind: "edit", id: item.id, edit });
  }, [api, vault]);
  const editorErrorNonce = useRef(0);
  const normalEditor = useCallback((item: MobileCaseDetailData) => {
    try {
      openEditor(item);
    } catch (error) {
      setPage({ kind: "resume-edit", id: item.id, nonce: --editorErrorNonce.current, initialError: errorMessage(error), normalEntry: true });
    }
  }, [openEditor]);
  const resumeEditor = useCallback((item: MobileCaseDetailData) => openEditor(item, true), [openEditor]);
  const openNote = useCallback((id: string, resume = false) => {
    let note = notes.current.get(id);
    if (!note) {
      note = new CaseNoteDraft(api, id, randomUUID, vault?.bind("case-note", id));
      notes.current.set(id, note);
    }
    if (!resume) note.newNote();
    setPage({ kind: "note", id, draft: note });
  }, [api, vault]);
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
      void queryClient.invalidateQueries({ queryKey: [...prefix, "overview"] });
      void queryClient.invalidateQueries({ queryKey: [...prefix, "list"] });
    }
  }
  const showList = useCallback(() => {
    setPage({ kind: "list" });
    if (state.status === "uncertain") {
      // A committed case may already have been reassigned. Review the whole
      // organization without owner, status or search restrictions.
      selectFilters(caseRecoverySelection());
      void queryClient.invalidateQueries({ queryKey: [...prefix, "list"] });
    }
  }, [state.status, queryClient, prefix, selectFilters]);
  const consumedRequest = useRef<number | null>(null);
  useEffect(() => {
    // The nonce is an explicit navigation command from the parent workspace.
    if (!active || !openRequest || !Number.isSafeInteger(openRequest.nonce) || consumedRequest.current === openRequest.nonce) return;
    consumedRequest.current = openRequest.nonce;
    const { kind, id, nonce } = openRequest;
    if (kind === "case-call-create") {
      const phone = customerCallNumber("inbound", openRequest.number);
      if (id !== null || !phone) return;
      draft.newDraft();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Consume an explicit external navigation command once.
      setPage({ kind: "new", callOffer: { number: phone, nonce } });
      return;
    }
    if (kind === "case-create") {
      if (id !== null) return;
      if (draft.snapshot().status === "uncertain") showList();
      else setPage({ kind: "new" });
      return;
    }
    if (!draftId(id)) return;
    if (kind === "case.owner") openOwner(id);
    else if (kind === "detail") showDetail(id);
    else if (kind === "case-edit") setPage({ kind: "resume-edit", id, nonce });
    else if (kind === "case-note") openNote(id, true);
    else if (kind === "handoff") openHandoffs(id);
    else if (kind === "task-create") setPage({ kind: "tasks", id, nonce });
    else if (kind === "attachment") setPage({ kind: "attachments", id });
  }, [active, openRequest, draft, showList, showDetail, openNote, openHandoffs, openOwner]);
  useAndroidBack(active && (page.kind === "detail" || page.kind === "list" && !!onLeaveCases), () => page.kind === "list" ? onLeaveCases?.() : showList());
  function showForm() { draft.newDraft(); setPage({ kind: "new" }); }
  return <View style={{ flex: 1 }}>
    {page.kind === "case.owner" ? <CaseOwnerForm draft={page.draft} active={active} onBack={() => showDetail(page.id)} onSaved={edited} />
      : page.kind === "resume-edit" ? <ResumeCaseEditor key={page.nonce} api={api} id={page.id} active={active} initialError={page.initialError} onLoaded={page.normalEntry ? openEditor : resumeEditor} onBack={showList} />
      : page.kind === "handoffs" ? <Handoffs draft={page.draft} active={active} onBack={() => showDetail(page.id)} />
      : page.kind === "attachments" ? <Attachments store={work} caseId={page.id} queryKey={prefix} active={active} visible={visible} onBack={() => showDetail(page.id)} />
      : page.kind === "tasks" ? <Tasks key={page.id + ":" + (page.nonce ?? "normal")} store={work} caseId={page.id} queryKey={prefix} profileId={profileId} active={active} onBack={() => showDetail(page.id)} />
      : page.kind === "list" ? <CaseList api={api} queryKey={prefix} active={active} ownership={ownership} category={category}
      search={search} ownerId={ownerId} status={status} priority={priority}
      onShortcut={value => selectFilters(caseShortcut(value))} onPriority={setPriority}
      onStatus={value => { setStatus(value); if (value && isClosedCaseStatus(value)) setCategory("all"); }} onSearch={setSearch} onOwnership={value => { setOwnership(value); setOwnerId(null); }}
      onOwner={id => { setOwnership("all"); setOwnerId(id); }} onCategory={value => { setCategory(value); setStatus(statusForCategory(status, value)); }} onOpen={showDetail}
      onNew={showForm} draftState={state} onReviewed={requestedAt => draft.reviewList(requestedAt)} />
      : page.kind === "new" ? <CaseForm api={api} active={active} visible={visible} draft={draft} state={state} onBack={showList} onSubmit={() => { void save(); }} callOffer={page.callOffer}
        onOfferDone={() => setPage(value => value.kind === "new" && value.callOffer?.nonce === page.callOffer?.nonce ? { kind: "new" } : value)} />
        : page.kind === "edit" ? <CaseEditor api={api} edit={page.edit} active={active} visible={visible} onSaved={edited} onBack={() => showDetail(page.id)} />
        : page.kind === "note" ? <CaseNoteForm active={active} draft={page.draft} onSaved={noteSaved} onBack={() => showDetail(page.id)} />
        : <CaseDetail onOwner={() => openOwner(page.id)} api={api} queryKey={prefix} active={active} id={page.id} created={state.created?.caseId === page.id ? state.created : null}
          onBack={showList} onHandoffs={() => openHandoffs(page.id)} onAttachments={() => setPage({ kind: "attachments", id: page.id })} onTasks={() => setPage({ kind: "tasks", id: page.id })} onSelectNumber={onSelectNumber} onEdit={normalEditor} onNote={openNote} savedNote={page.note} onNoteUpdated={noteUpdated} />}
  </View>;
}

/** Explicit resumes read current scoped detail without accepting cached data. */
function ResumeCaseEditor({ api, id, active, initialError, onLoaded, onBack }: {
  api: CasesApi; id: string; active: boolean; initialError?: string; onLoaded: (item: MobileCaseDetailData) => void; onBack: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(initialError ?? null);
  useAndroidBack(active, onBack);
  useEffect(() => {
    if (!active || initialError && attempt === 0) return;
    const read = new AbortController();
    void (async () => {
      try {
        const result = await api.detail(id, read.signal);
        if (!read.signal.aborted) onLoaded(result.case);
      } catch (error) {
        if (!read.signal.aborted) setError(errorMessage(error));
      }
    })();
    return () => read.abort();
  }, [api, id, active, attempt, initialError, onLoaded]);
  return <View style={styles.content}>
    <Button label="Späť na prípady" secondary onPress={onBack} />
    {error ? <ErrorNotice message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} /> : <Loading />}
  </View>;
}

function CaseList({ api, queryKey, active, ownership, category, search, ownerId, status, priority, onStatus, onPriority, onShortcut, onOwner, onSearch, onOwnership, onCategory, onOpen, onNew, draftState, onReviewed }: {
  api: CasesApi; queryKey: string[]; active: boolean; ownership: MobileCaseFilter["ownership"]; category: MobileCaseFilter["category"]; search: string; ownerId: string | null; onOwner: (id: string | null) => void;
  status: MobileCaseFilter["status"]; priority: MobileCaseFilter["priority"]; onStatus: (value: MobileCaseFilter["status"]) => void; onPriority: (value: MobileCaseFilter["priority"]) => void; onShortcut: (value: CaseShortcut) => void;
  onSearch: (value: string) => void; onOwnership: (value: MobileCaseFilter["ownership"]) => void; onCategory: (value: MobileCaseFilter["category"]) => void;
  onOpen: (id: string) => void; onNew: () => void; draftState: DraftState; onReviewed: (requestedAt: number) => void;
}) {
  const queryClient = useQueryClient();
  const ownerOverlay = usePhoneOverlay<boolean>(active);
  const selectingOwner = ownerOverlay.value === true;
  const dispatchers = useQuery({ queryKey: [...queryKey, "dispatchers"], queryFn: ({ signal }) => api.dispatchers(signal), enabled: active && (selectingOwner || ownerId !== null) });
  const selectedOwner = dispatchers.isError ? undefined : dispatchers.data?.dispatchers.find(item => item.id === ownerId);
  const [debounced, setDebounced] = useState(search.trim());
  useEffect(() => { const timer = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  const query = useInfiniteQuery({
    queryKey: [...queryKey, "list", ownership, ownerId, category, debounced, status ?? null, priority ?? null], enabled: active,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.list({ ownership, ownerId, category, status, priority, q: debounced, cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const pendingSearch = search.trim() !== debounced;
  const denied = query.error instanceof MobileApiError && [401, 403, 409, 502].includes(query.error.status);
  const canShow = active && !pendingSearch && !denied && !(query.isError && !query.isFetchNextPageError);
  useEffect(() => {
    if (canShow && query.isSuccess && !query.isFetching && canReviewCaseCreation({ ownership, ownerId, category, q: debounced, status, priority })) onReviewed(query.data?.pages[0]?.requestedAt ?? 0);
  }, [active, canShow, query.isSuccess, query.isFetching, query.data, ownership, ownerId, category, debounced, status, priority, onReviewed]);
  const cases = [...new Map(query.data?.pages.flatMap(page => page.cases).map(item => [item.id, item]) ?? []).values()];
  const hasDraft = draftState.status !== "saved" && Object.entries(draftState.input).some(([key, value]) =>
    key === "priority" ? value !== "normal" : Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim().length > 0);
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { if (active) { void query.refetch(); void queryClient.invalidateQueries({ queryKey: [...queryKey, "overview"] }); } }} />}>
    <Text style={styles.heading}>Prípady</Text>
    <Button label={draftState.status === "saving" ? "Ukladanie prípadu…" : draftState.status === "uncertain" ? "Overiť uloženie prípadu" : hasDraft ? "Rozpracovaný prípad" : "Nový prípad"} onPress={onNew} />
    {draftState.status === "uncertain" && <Card><Text style={styles.text}>Skontrolujte, či sa váš prípad už uložil. Nájdete ho podľa mena, EČV alebo času vytvorenia.</Text>
      {draftState.reviewedList && <Text style={styles.muted}>Ak ho nenájdete, v rozpracovanom formulári môžete vedome povoliť opakovanie.</Text>}</Card>}
    <CaseOverview api={api} queryKey={queryKey} active={active} pendingFilter={pendingSearch || query.isFetching} onSelect={onShortcut} />
    <View style={s.search}><Search size={16} color={colors.muted} accessible={false} />
      <TextInput accessibilityLabel="Hľadať prípady" placeholder="Číslo prípadu, meno alebo EČV" placeholderTextColor={colors.muted} value={search}
        onChangeText={onSearch} maxLength={120} style={s.searchInput} autoCorrect={false} returnKeyType="search" /></View>
    <View style={s.choices}>
      <Choice label="Nepriradené" selected={ownership === "unassigned"} onPress={() => onOwnership("unassigned")} />
      <Choice label="Moje" selected={ownership === "mine"} onPress={() => onOwnership("mine")} />
      <Choice label="Všetkých" selected={ownership === "all" && ownerId === null} onPress={() => onOwnership("all")} />
      <MenuChip label={ownerId ? "Dispečer: " + (selectedOwner ? selectedOwner.name + (selectedOwner.active ? "" : " (neaktívny)") : "vybraný") : "Dispečer"}
        active={ownerId !== null} disabled={!ownerOverlay.canOpen} onPress={() => { Keyboard.dismiss(); ownerOverlay.open(true); }} />
    </View>
    <Modal visible={active && selectingOwner} transparent animationType="fade" onRequestClose={ownerOverlay.close}>
      <View style={s.modalBackdrop}><View accessibilityViewIsModal style={s.modalCard}>
        <Text style={styles.subheading}>Vybrať dispečera</Text>
        <Button label="Zavrieť výber" secondary onPress={ownerOverlay.close} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
          <Choice label="Všetci dispečeri" selected={ownership === "all" && ownerId === null} onPress={ownerOverlay.guard(() => { onOwner(null); ownerOverlay.close(); })} />
          {dispatchers.isPending ? <Loading /> : dispatchers.isError ? <ErrorNotice message={errorMessage(dispatchers.error)} onRetry={() => { void dispatchers.refetch(); }} />
            : dispatchers.data?.dispatchers.map(item => <Choice key={item.id} label={item.name + (item.active ? "" : " (neaktívny)")} selected={ownerId === item.id}
              onPress={ownerOverlay.guard(() => { onOwner(item.id); ownerOverlay.close(); })} />)}
        </ScrollView>
      </View></View>
    </Modal>
    <View style={s.choices}>
      <Choice label="Otvorené" selected={category === "open"} onPress={() => onCategory("open")} />
      <Choice label="Aj uzavreté" selected={category === "all"} onPress={() => onCategory("all")} />
      <CaseFilterControls active={active} status={status} priority={priority} onStatus={onStatus} onPriority={onPriority} />
    </View>
    {pendingSearch || query.isPending ? <Loading /> : !canShow ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} />
      : <>{cases.length === 0 && <Card><Text style={styles.text}>Žiadne prípady pre tento výber.</Text></Card>}
        {cases.length > 0 && <View style={s.group}>{cases.map((item, index) => <CaseRow key={item.id} item={item} first={index === 0} onPress={() => onOpen(item.id)} />)}</View>}
        {query.isFetchNextPageError && <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.fetchNextPage(); }} />}
        {query.hasNextPage && !query.isFetchNextPageError && <Button label={query.isFetchingNextPage ? "Načítavam…" : "Ďalšie prípady"} secondary disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} />}
      </>}
  </ScrollView>;
}
const priorityBar: Partial<Record<MobileCaseSummary["priority"], string>> = { urgent: "#FF383C", high: "#FF8D28" };
/** One case in up to three lines: who and which car, number and place, state. */
function CaseRow({ item, first, onPress }: { item: MobileCaseSummary; first: boolean; onPress: () => void }) {
  const title = [item.contact.name || "Kontakt bez mena", item.vehicle.licensePlate].filter(Boolean).join(" · ");
  return <Pressable accessibilityRole="button" accessibilityLabel={"Otvoriť prípad " + item.caseNumber + ", " + title} onPress={onPress}
    style={({ pressed }) => [s.caseRow, pressed && { backgroundColor: "#ECECF0" }]}>
    {!first && <View style={s.separator} />}
    {priorityBar[item.priority] && <View style={[s.bar, { backgroundColor: priorityBar[item.priority] }]} />}
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <View style={s.titleLine}><Text numberOfLines={1} style={s.caseTitle}>{title}</Text><Text style={s.caseTime}>{formatTime(item.createdAt)}</Text></View>
      <Text numberOfLines={1} style={styles.muted}>{[item.caseNumber, item.pickupAddress || item.summary || "Miesto nedoplnené"].filter(Boolean).join(" · ")}</Text>
      <View style={s.tags}>
        {(item.priority === "urgent" || item.priority === "high") && <Text style={[s.tag, item.priority === "urgent" ? s.tagRed : s.tagOrange]}>{item.priorityLabel}</Text>}
        <Text style={[s.tag, s.tagGray]}>{item.statusLabel}</Text>
        {item.owner.mine ? <Text style={[s.tag, s.tagYellow]}>Môj</Text> : <Text numberOfLines={1} style={s.owner}>{item.owner.name || "Bez vlastníka"}</Text>}
      </View>
    </View>
  </Pressable>;
}
function CaseHeading({ item }: { item: MobileCaseSummary }) {
  return <View style={{ gap: 5 }}><Text style={styles.subheading}>{item.caseNumber}</Text>
    <Text style={[styles.muted, item.priority === "urgent" && { color: colors.danger }]}>{item.statusLabel} · {item.priorityLabel}</Text></View>;
}
function Info({ label, value }: { label: string; value: string | null }) {
  return <View><Text style={styles.label}>{label}</Text><Text selectable style={styles.text}>{value || "Nedoplnené"}</Text></View>;
}
function CaseDetail({ api, queryKey, active, id, created, onBack, onHandoffs, onAttachments, onTasks, onSelectNumber, onEdit, onNote, savedNote, onNoteUpdated, onOwner }: {
  api: CasesApi; queryKey: string[]; active: boolean; id: string; created: DraftState["created"]; onBack: () => void; onOwner: () => void; onHandoffs: () => void; onAttachments: () => void; onTasks: () => void; onSelectNumber: (number: string) => void; onEdit: (item: MobileCaseDetailData) => void; onNote: (id: string) => void; savedNote?: CaseNoteDraft; onNoteUpdated: (receipt: MobileCaseNoteAdded) => void;
}) {
  const query = useQuery({ queryKey: [...queryKey, "detail", id], queryFn: ({ signal }) => api.detail(id, signal), enabled: active });
  const item = query.isError ? null : query.data?.case;
  const mapOverlay = usePhoneOverlay<"pickup" | "destination">(active);
  const mapTarget = mapOverlay.value;
  return <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => { void query.refetch(); }} />}>
    <Button label="Späť na prípady" onPress={onBack} secondary />
    {savedNote && <CaseNoteSavedNotice draft={savedNote} onUpdated={onNoteUpdated} />}
    {created && <Card><Text accessibilityRole="alert" style={styles.subheading}>Prípad {created.caseNumber} je uložený.</Text>
      {created.warnings.map((warning, index) => <Text key={warning.code + index} style={styles.text}>{warning.message}</Text>)}</Card>}
    {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} />
      : item && <><Text style={styles.muted}>Údaje overené {formatTime(query.data!.checkedAt)}</Text><Button label="Dispečer prípadu" secondary onPress={onOwner} /><Button label="Upraviť prípad" onPress={() => onEdit(item)} /><Button label="Pridať poznámku" secondary onPress={() => onNote(item.id)} /><Button label="Prílohy prípadu" secondary onPress={onAttachments} /><Button label="Úlohy prípadu" secondary onPress={onTasks} /><Button label="Odovzdať prípad" secondary onPress={onHandoffs} /><Card><CaseHeading item={item} /><CopyValue scopeKey={id} active={active} label="Kopírovať číslo prípadu" value={item.caseNumber} /><Text style={styles.muted}>{item.owner.mine ? "Môj prípad" : item.owner.name || "Bez vlastníka"} · {formatTime(item.createdAt)}</Text></Card>
        <Card><Info label="Kontakt" value={item.contact.name} /><Info label="Telefón" value={item.contact.phone ? formatNumber(item.contact.phone) : null} />
          <CopyValue scopeKey={id} active={active} label="Kopírovať telefón" value={item.contact.phone} />
          {dialable(item.contact.phone) && <Button label="Vybrať číslo v ústredni" onPress={() => { if (item.contact.phone) onSelectNumber(item.contact.phone); }} secondary />}</Card>
        <Card><Info label="EČV" value={item.vehicle.licensePlate} /><CopyValue scopeKey={id} active={active} label="Kopírovať EČV" value={item.vehicle.licensePlate} /><Info label="Vozidlo" value={item.vehicle.description} /><Info label="Služba" value={item.jobTypeLabels.join(", ")} /></Card>
        <Card><Info label="Vyzdvihnutie" value={item.pickupAddress} /><Info label="Cieľ" value={item.destinationAddress} />
          <CopyValue scopeKey={id} active={active} label="Kopírovať vyzdvihnutie" value={item.pickupAddress} /><CopyValue scopeKey={id} active={active} label="Kopírovať cieľ" value={item.destinationAddress} />
          {(["pickup", "destination"] as const).map(target => { const place = item.map?.[target]; return place?.point && <View key={target} style={{ gap: 8 }}>
            <Info label={target === "pickup" ? "Poloha vyzdvihnutia" : "Poloha cieľa"} value={`${place.point.lat}, ${place.point.lng}`} />
            <Text style={styles.muted}>Zdroj: {place.source === "google_places" ? "Google Places" : place.source === "client_gps" ? "GPS klienta" : place.source === "approximate" ? "Približný bod" : place.source === "manual" ? "Ručne zadané" : "Neznámy"}</Text>
            <CopyValue scopeKey={id} active={active} label="Kopírovať súradnice" value={`${place.point.lat}, ${place.point.lng}`} />
            <Button label={target === "pickup" ? "Mapa vyzdvihnutia" : "Mapa cieľa"} secondary disabled={!mapOverlay.canOpen} onPress={() => mapOverlay.open(target)} />
          </View>; })}
          {item.map?.clientLocation?.point && <View style={{ gap: 8 }}>
            <Info label="Prijatá poloha klienta" value={`${item.map.clientLocation.point.lat}, ${item.map.clientLocation.point.lng}`} />
            <Text style={styles.muted}>{item.map.clientLocation.capturedAt ? formatTime(item.map.clientLocation.capturedAt) : "Čas nezistený"}{item.map.clientLocation.accuracyMeters !== null ? ` · presnosť približne ${Math.round(item.map.clientLocation.accuracyMeters)} m` : ""}</Text>
            <CopyValue scopeKey={id} active={active} label="Kopírovať GPS klienta" value={`${item.map.clientLocation.point.lat}, ${item.map.clientLocation.point.lng}`} />
            <Button label="Mapa polohy klienta" secondary disabled={!mapOverlay.canOpen} onPress={() => mapOverlay.open("pickup")} />
          </View>}
          <Navigate label="Navigovať na vyzdvihnutie" address={item.pickupAddress} /><Navigate label="Navigovať do cieľa" address={item.destinationAddress} /></Card>
        <Card><Info label="Problém" value={item.incidentDescription || item.summary} /><Info label="Poznámka" value={item.mainNote} /></Card>
        <Text style={styles.subheading}>Posledné udalosti</Text>
        {item.timeline.length === 0 && <Text style={styles.muted}>Zatiaľ bez udalostí.</Text>}
        {item.timeline.map(event => <Card key={event.id}><Text style={styles.label}>{event.title}</Text>{Boolean(event.body) && <Text selectable style={styles.text}>{event.body}</Text>}
          <Text style={styles.muted}>{formatTime(event.createdAt)}{event.actorName ? " · " + event.actorName : ""}</Text></Card>)}
      </>}
    {active && item && mapTarget && <CaseMapFrame key={`${id}:view:${mapTarget}`} api={api} caseId={id} mode="view" target={mapTarget} seed={{ selection: null, address: "" }} onClose={mapOverlay.close} />}
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
function CaseForm({ api, draft, state, active, visible, onBack, onSubmit, callOffer, onOfferDone }: { api: CasesApi; active: boolean; visible: boolean; draft: CaseDraft; state: DraftState; onBack: () => void; onSubmit: () => void; callOffer?: CallOffer; onOfferDone: () => void }) {
  const mapOverlay = usePhoneOverlay<"pickup" | "destination">(visible, active);
  const mapTarget = mapOverlay.value;
  const saving = state.status === "saving", uncertain = state.status === "uncertain";
  const back = () => { if (draft.snapshot().status !== "saving") onBack(); };
  useAndroidBack(active, back, saving);
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}>
      <Button label="Späť na prípady" onPress={back} disabled={saving} secondary /><Text style={styles.heading}>Nový prípad</Text>
      <Text style={styles.muted}>Môžete uložiť aj neúplný koncept. Údaje doplníte neskôr v dispečingu.</Text>
      {callOffer && <CallPhoneOffer key={callOffer.nonce} draft={draft} state={state} number={callOffer.number} active={active && visible} onDone={onOfferDone} />}
      {fields.map(field => <View key={field.key}><Text style={styles.label}>{field.label}</Text>
        <TextInput accessibilityLabel={field.label} value={field.key === "manualPickupAddress" ? state.input.pickup?.address ?? state.input.manualPickupAddress ?? "" : field.key === "manualDestinationAddress" ? state.input.destination?.address ?? state.input.manualDestinationAddress ?? "" : state.input[field.key] ?? ""} onChangeText={value => draft.edit({ [field.key]: value })}
          editable={!saving} maxLength={field.max} multiline={field.multiline} keyboardType={field.key === "contactPhone" ? "phone-pad" : "default"}
          autoCapitalize={field.key === "licensePlate" ? "characters" : "sentences"} autoCorrect={field.key !== "licensePlate" && field.key !== "contactPhone"}
          style={[styles.input, field.multiline && { minHeight: 90, textAlignVertical: "top" }]} />
        {(field.key === "manualPickupAddress" || field.key === "manualDestinationAddress") && <Button label="Vybrať miesto na mape" secondary disabled={state.status !== "editing" || !mapOverlay.canOpen}
          onPress={() => mapOverlay.open(field.key === "manualPickupAddress" ? "pickup" : "destination")} />}
      </View>)}
      <View><Text style={styles.label}>Služba</Text><View style={s.choices}>{jobTypes.map(item => {
        const selected = state.input.jobTypes?.includes(item.value) === true;
        return <Choice key={item.value} label={item.label} selected={selected} disabled={saving} onPress={() => draft.edit({ jobTypes: selected
          ? state.input.jobTypes?.filter(value => value !== item.value) : [...(state.input.jobTypes ?? []), item.value] })} />;
      })}</View></View>
      <View><Text style={styles.label}>Priorita</Text><View style={s.choices}>{priorities.map(item => <Choice key={item.value} label={item.label}
        selected={state.input.priority === item.value} disabled={saving} onPress={() => draft.edit({ priority: item.value })} />)}</View></View>
      {state.error && <ErrorNotice message={state.error} />}
      {uncertain && <><Button label="Skontrolovať zoznam prípadov" onPress={back} secondary />
        {state.reviewedList && <Button label="Prípad som nenašiel – povoliť opakovanie" onPress={() => draft.allowRetry()} secondary />}</>}
      {mapTarget && state.status === "editing" && <CasePlacePicker key={`new:pick:${mapTarget}`} api={api} caseId={null} active={active} visible={visible} target={mapTarget}
        seed={{ selection: state.input[mapTarget] ?? null, address: state.input[mapTarget]?.address ?? state.input[mapTarget === "pickup" ? "manualPickupAddress" : "manualDestinationAddress"] ?? "" }}
        onClose={mapOverlay.close} onApply={mapOverlay.guard(value => draft.selectPlace(mapTarget, value))} />}
      <Button label={saving ? "Ukladám prípad…" : "Uložiť prípad"} disabled={saving || uncertain || state.status === "saved"} onPress={() => { Keyboard.dismiss(); onSubmit(); }} />
    </ScrollView>
  </KeyboardAvoidingView>;
}
const s = StyleSheet.create({
  modalBackdrop: { flex: 1, justifyContent: "center", padding: 20, backgroundColor: "rgba(0,0,0,0.5)" },
  modalCard: { maxHeight: "80%", backgroundColor: colors.white, borderRadius: 20, padding: 20, gap: 16 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  search: { minHeight: 38, borderRadius: 19, backgroundColor: "rgba(118,118,128,0.12)", flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12 },
  searchInput: { flex: 1, minHeight: 38, fontSize: 16, color: colors.ink, paddingVertical: 0 },
  group: { backgroundColor: colors.white, borderRadius: 16, overflow: "hidden" },
  caseRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 8, minHeight: 64 },
  separator: { position: "absolute", top: 0, left: 12, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: "rgba(60,60,67,0.16)" },
  bar: { position: "absolute", left: 0, top: 9, bottom: 9, width: 3, borderTopRightRadius: 3, borderBottomRightRadius: 3 },
  titleLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  caseTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600", color: colors.ink, flex: 1 },
  caseTime: { fontSize: 12, lineHeight: 16, fontWeight: "500", color: colors.muted, fontVariant: ["tabular-nums"] },
  tags: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2, overflow: "hidden" },
  tag: { fontSize: 11, lineHeight: 14, fontWeight: "700", borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden" },
  tagRed: { backgroundColor: "#FFE7E6", color: "#C4161B" }, tagOrange: { backgroundColor: "#FFF0E0", color: "#B35A00" },
  tagGray: { backgroundColor: "rgba(118,118,128,0.12)", color: "#3A3A3C" }, tagYellow: { backgroundColor: "#FFF6BF", color: "#7D6300" },
  owner: { fontSize: 12, lineHeight: 16, color: colors.muted, flexShrink: 1 },
});
