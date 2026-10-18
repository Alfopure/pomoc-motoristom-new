import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { PhoneIncoming, PhoneMissed } from "lucide-react-native";
import type { MobileCallbackRequest } from "../../../src/lib/mobile-callbacks";
import { MOBILE_CALLBACK_NOTE_LIMIT } from "../../../src/lib/mobile-callbacks";
import { formatNumber, formatTime } from "../lib/display";
import { useAndroidBack } from "../lib/use-android-back";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "../ui";
import { useForegroundVisit } from "../ui/foreground-visit";
import type { CallbackQueueStore } from "./store";
import { callbackFilters, callbackOriginLabels, callbackStatusLabels, callbackUrgency, deadlineText, filterCallbacks, formatWait, waitingLabel, type CallbackFilter } from "./model";

export type HistoryView = "calls" | "callbacks";
export function HistorySegment({ view, onView, open }: { view: HistoryView; onView: (view: HistoryView) => void; open?: number | null }) {
  const items: { id: HistoryView; label: string; count?: number | null }[] = [{ id: "calls", label: "Hovory" }, { id: "callbacks", label: "Spätné volania", count: open }];
  return <View accessibilityRole="tablist" style={s.segment}>{items.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: item.id === view }}
    accessibilityLabel={item.label + (item.count ? ", " + item.count + " čaká" : "")}
    onPress={() => onView(item.id)} style={({ pressed }) => [s.segmentItem, item.id === view && s.segmentSelected, pressed && { opacity: 0.75 }]}>
    <Text numberOfLines={2} style={[s.segmentText, item.id === view && { color: colors.ink }]}>{item.label}</Text>
    {Boolean(item.count) && <View style={s.badge}><Text style={s.badgeText}>{item.count! > 99 ? "99+" : item.count}</Text></View>}
  </Pressable>)}</View>;
}

export type CallbackDialer = { available: boolean; reason: string | null; dial: (id: string, number: string, verificationId?: string) => Promise<string | null> };
const urgencyColor = { fresh: colors.muted, due: "#9A6700", overdue: colors.danger } as const;

export function CallbacksPanel({ store, active, current, dialer, onShowCalls, onOpenCase }: {
  store: CallbackQueueStore; active: boolean; current: () => boolean; dialer: CallbackDialer;
  onShowCalls: () => void; onOpenCase: (id: string) => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const visit = useForegroundVisit(active);
  const [filter, setFilter] = useState<CallbackFilter>("all");
  const [showResolved, setShowResolved] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { store.setActive(active); if (active) void store.refresh(); }, [store, active, visit.revision]);
  useEffect(() => () => store.setActive(false), [store]);
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setNow(Date.now()), 30_000), poll = setInterval(() => { void store.refresh(); }, 30_000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [store, active]);
  useAndroidBack(active, onShowCalls, Boolean(state.pending));
  const allowed = () => visit.current() && current();
  const shown = useMemo(() => filterCallbacks(state.open, filter), [state.open, filter]);
  const overdue = state.nextCursor ? null : state.open.filter(item => callbackUrgency(item, now) === "overdue").length;
  async function call(item: MobileCallbackRequest) {
    if (!allowed() || !item.number) return;
    const decision = await store.prepareCall(item.id);
    if (!decision || !allowed()) return;
    const start = async (verificationId?: string) => { if (allowed() && item.number) store.callStarted(item.id, await dialer.dial(item.id, item.number, verificationId)); };
    if (decision.kind === "dial") { await start(); return; }
    Alert.alert(decision.title, decision.message, [{ text: "Zrušiť", style: "cancel" }, { text: "Zavolať", onPress: () => { void start(decision.verificationId); } }]);
  }
  function claim(item: MobileCallbackRequest) {
    if (!allowed()) return;
    if (!item.actions.takeover) { void store.claim(item.id); return; }
    Alert.alert("Prevziať od kolegu?", "Požiadavku má prevzatú " + (item.claimant?.name ?? "iný dispečer") + ". Prevzatím ju budete riešiť vy.", [
      { text: "Zrušiť", style: "cancel" }, { text: "Prevziať", onPress: () => { if (allowed()) void store.claim(item.id); } }]);
  }
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={state.loading && Boolean(state.counts)} onRefresh={() => { void store.refresh(); }} />}>
    <HistorySegment view="callbacks" onView={view => { if (view === "calls") onShowCalls(); }} open={state.counts?.open} />
    <Text accessibilityRole="header" style={styles.heading}>Spätné volania</Text>
    {state.counts && <Card style={s.summary}>
      <Text style={s.summaryCount}>{state.counts.open ? waitingLabel(state.counts.open) : "Nikto nečaká"}</Text>
      <Text style={styles.muted}>Vyžiadané klientom {state.counts.requested} · Zmeškané {state.counts.missed} · Zadané dispečerom {state.counts.manual}{state.counts.unknown ? " · Staršie " + state.counts.unknown : ""}</Text>
      {overdue !== null && overdue > 0 && <Text style={[styles.label, { color: colors.danger, marginBottom: 0 }]}>Po termíne: {overdue}</Text>}
      {state.checkedAt && <Text style={styles.muted}>Overené {formatTime(state.checkedAt)}</Text>}
    </Card>}
    {!dialer.available && dialer.reason && <Text style={styles.muted}>{dialer.reason}</Text>}
    <View style={s.filters}>{callbackFilters.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === filter }}
      onPress={() => setFilter(item.id)} style={({ pressed }) => [s.filter, item.id === filter && s.filterSelected, pressed && { opacity: 0.75 }]}>
      <Text style={[s.filterText, item.id === filter && { color: colors.white }]}>{item.label}</Text></Pressable>)}</View>
    {state.notice && state.notice.id === null && <Notice tone={state.notice.tone} message={state.notice.message} />}
    {state.loading && !state.counts ? <Loading label="Načítavam spätné volania…" /> : state.error && !state.counts ? <ErrorNotice message={state.error} onRetry={() => { void store.refresh(); }} /> : <>
      {state.error && <ErrorNotice message={state.error} onRetry={() => { void store.refresh(); }} />}
      {shown.length === 0 && <Card><Text style={styles.text}>{state.open.length ? "Pre tento výber nie je žiadna otvorená požiadavka." : "Nikto nečaká na spätné volanie."}</Text>
        {filter !== "all" && state.nextCursor && <Text style={styles.muted}>Ďalšie požiadavky ešte nie sú načítané.</Text>}</Card>}
      {shown.map(item => <CallbackCard key={item.id} item={item} now={now} state={state} dialer={dialer}
        onCall={() => { void call(item); }} onClaim={() => claim(item)} onOpenCase={() => { if (allowed() && item.caseId) onOpenCase(item.caseId); }}
        onEditor={status => store.openEditor(item.id, status)} onNotes={value => store.editNotes(value)} onCloseEditor={() => store.closeEditor()}
        onResolve={() => { if (allowed()) void store.resolve(); }} />)}
      {state.moreError && <ErrorNotice message={state.moreError} onRetry={() => { void store.loadMore(); }} />}
      {state.nextCursor && !state.moreError && <Button label={state.loadingMore ? "Načítavam…" : "Ďalšie požiadavky"} secondary disabled={state.loadingMore} onPress={() => { void store.loadMore(); }} />}
      {state.resolved.length > 0 && <Button label={(showResolved ? "Skryť" : "Zobraziť") + " uzavreté za 24 h (" + state.resolved.length + ")"} secondary onPress={() => setShowResolved(value => !value)} />}
      {showResolved && state.resolved.map(item => <Card key={item.id}>
        <Text style={styles.subheading}>{item.name || formatNumber(item.number)}</Text>
        <Text style={styles.text}>{callbackStatusLabels[item.status]}{item.claimant ? " · " + (item.claimant.mine ? "vy" : item.claimant.name ?? "dispečer") : ""}</Text>
        {item.resolvedAt && <Text style={styles.muted}>Uzavreté {formatTime(item.resolvedAt)}</Text>}
        {item.notes && <Text style={styles.text}>{item.notes}</Text>}
      </Card>)}
    </>}
  </ScrollView>;
}

function Notice({ tone, message }: { tone: "error" | "info"; message: string }) {
  return <View style={[s.notice, tone === "error" && s.noticeError]}><Text accessibilityRole="alert" style={[styles.text, tone === "error" && { color: colors.danger }]}>{message}</Text></View>;
}

function CallbackCard({ item, now, state, dialer, onCall, onClaim, onOpenCase, onEditor, onNotes, onCloseEditor, onResolve }: {
  item: MobileCallbackRequest; now: number; state: ReturnType<CallbackQueueStore["snapshot"]>; dialer: CallbackDialer;
  onCall: () => void; onClaim: () => void; onOpenCase: () => void; onEditor: (status: "done" | "cancelled") => void;
  onNotes: (value: string) => void; onCloseEditor: () => void; onResolve: () => void;
}) {
  const urgency = callbackUrgency(item, now), busy = state.pending !== null, mine = state.pending?.id === item.id;
  const editor = state.editor?.id === item.id ? state.editor : null;
  const Icon = item.origin === "requested" ? PhoneIncoming : PhoneMissed;
  const deadline = deadlineText(item, now);
  return <Card style={urgency === "overdue" ? s.overdueCard : undefined}>
    <View style={[styles.row, { alignItems: "flex-start" }]}>
      <View style={[s.icon, urgency === "overdue" && s.iconOverdue, urgency === "due" && s.iconDue]}><Icon size={22} strokeWidth={1.9} color={urgencyColor[urgency] === colors.muted ? colors.ink : urgencyColor[urgency]} accessible={false} /></View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={styles.subheading}>{item.name || formatNumber(item.number)}</Text>
        {item.name && <Text selectable style={styles.text}>{formatNumber(item.number)}</Text>}
        <Text style={styles.muted}>{callbackOriginLabels[item.origin]}</Text>
      </View>
    </View>
    {item.originDetail && <Text style={styles.muted}>{item.originDetail}</Text>}
    {/* The origin already names missed, requested and manual rows; older rows keep their route. */}
    {(item.origin === "unknown" || item.lineLabel || item.partnerName) && <Text style={styles.muted}>{[item.origin === "unknown" ? item.sourceLabel : null, item.lineLabel ?? item.partnerName].filter(Boolean).join(" · ")}</Text>}
    <Text style={[styles.text, { color: urgencyColor[urgency] === colors.muted ? colors.ink : urgencyColor[urgency] }]}>Čaká {formatWait(item.createdAt, now)}{deadline ? " · " + deadline : ""}</Text>
    <Text style={styles.text}>{item.claimant ? (item.claimant.mine ? "Prevzali ste" : "Prevzal(a) " + (item.claimant.name ?? "iný dispečer")) : callbackStatusLabels[item.status]}</Text>
    {item.lastCalledAt && <Text style={styles.muted}>Naposledy volané {formatTime(item.lastCalledAt)}</Text>}
    {item.notes && <Text style={styles.text}>{item.notes}</Text>}
    {state.notice?.id === item.id && <Notice tone={state.notice.tone} message={state.notice.message} />}
    {item.actions.blockedReason && <Text style={styles.muted}>{item.actions.blockedReason}</Text>}
    {editor ? <View style={{ gap: 10 }}>
      <Text style={styles.label}>{editor.status === "done" ? "Poznámka k vybaveniu (nepovinné)" : "Dôvod zrušenia (nepovinné)"}</Text>
      <TextInput accessibilityLabel={editor.status === "done" ? "Poznámka k vybaveniu" : "Dôvod zrušenia"} value={editor.notes} onChangeText={onNotes} multiline maxLength={MOBILE_CALLBACK_NOTE_LIMIT}
        editable={!busy} placeholder="Napríklad: dovolané, odťah objednaný" placeholderTextColor={colors.muted} selectionColor={colors.brand} style={[styles.input, { minHeight: 88, textAlignVertical: "top" }]} />
      <Text style={styles.muted}>{editor.notes.length}/{MOBILE_CALLBACK_NOTE_LIMIT}</Text>
      <Button label={mine && state.pending?.action === "resolve" ? "Ukladám…" : editor.status === "done" ? "Potvrdiť vybavenie" : "Potvrdiť zrušenie"} disabled={busy} onPress={onResolve} />
      <Button label="Späť bez uzavretia" secondary disabled={busy} onPress={onCloseEditor} />
    </View> : <View style={{ gap: 10 }}>
      {item.actions.call && <Button label={mine && state.pending?.action === "call" ? "Overujem číslo…" : "Zavolať späť"} disabled={busy || !dialer.available} onPress={onCall} />}
      {item.actions.claim && <Button label={mine && state.pending?.action === "claim" ? "Preberám…" : item.actions.takeover ? "Prevziať od kolegu" : "Prevziať"} secondary disabled={busy} onPress={onClaim} />}
      {item.actions.resolve && <View style={styles.row}>
        <View style={{ flex: 1 }}><Button label="Vybavené" secondary disabled={busy} onPress={() => onEditor("done")} /></View>
        <View style={{ flex: 1 }}><Button label="Zrušiť" secondary disabled={busy} onPress={() => onEditor("cancelled")} /></View>
      </View>}
      {item.caseId && <Button label="Otvoriť prípad" secondary onPress={onOpenCase} />}
    </View>}
  </Card>;
}

const s = StyleSheet.create({
  segment: { flexDirection: "row", backgroundColor: "#E7E9EE", borderRadius: 16, padding: 4, gap: 4 },
  segmentItem: { flex: 1, minHeight: 40, borderRadius: 12, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 8, paddingVertical: 4 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: colors.danger, alignItems: "center", justifyContent: "center" },
  badgeText: { color: colors.white, fontSize: 12, fontWeight: "700" },
  segmentSelected: { backgroundColor: colors.white, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  segmentText: { fontSize: 14, fontWeight: "600", color: colors.muted, textAlign: "center", flexShrink: 1 },
  summary: { backgroundColor: "#FEFEFB" },
  summaryCount: { fontSize: 26, fontWeight: "700", letterSpacing: -0.6, color: colors.ink },
  filters: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  filter: { borderRadius: 22, minHeight: 44, backgroundColor: "#EDEFF2", paddingHorizontal: 15, paddingVertical: 11, alignItems: "center", justifyContent: "center" },
  filterText: { fontSize: 14, fontWeight: "600", color: colors.muted },
  filterSelected: { backgroundColor: colors.ink },
  icon: { width: 44, height: 44, borderRadius: 16, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  iconDue: { backgroundColor: "#FFF4D6" },
  iconOverdue: { backgroundColor: "#FFF0EF" },
  overdueCard: { borderColor: "#F4C7C3" },
  notice: { backgroundColor: colors.notice, borderWidth: 1, borderColor: colors.noticeBorder, borderRadius: 16, padding: 12 },
  noticeError: { backgroundColor: "#FFF0EF", borderColor: "#F4C7C3" },
});
