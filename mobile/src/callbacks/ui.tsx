import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ChevronDown, ChevronUp, PhoneIncoming, PhoneMissed } from "lucide-react-native";
import type { MobileCallbackRequest } from "../../../src/lib/mobile-callbacks";
import { MOBILE_CALLBACK_NOTE_LIMIT } from "../../../src/lib/mobile-callbacks";
import { formatNumber, formatTime } from "../lib/display";
import { useAndroidBack } from "../lib/use-android-back";
import { Button, Card, ErrorNotice, Loading, NAVIGATION_CONTENT_BOTTOM, colors, styles } from "../ui";
import { Tag } from "../design/detail";
import { Group } from "../design/list";
import { palette, space, type } from "../design/tokens";
import { useForegroundVisit } from "../ui/foreground-visit";
import type { CallbackQueueStore } from "./store";
import { callbackFilters, callbackOriginLabels, callbackStatusLabels, callbackUrgency, deadlineText, filterCallbacks, formatWait, waitingLabel, type CallbackFilter } from "./model";

export type CallbackDialer = { available: boolean; reason: string | null; dial: (id: string, number: string, verificationId?: string) => Promise<string | null> };

export function CallbacksPanel({ store, active, current, dialer, onShowCalls, onOpenCase }: {
  store: CallbackQueueStore; active: boolean; current: () => boolean; dialer: CallbackDialer;
  onShowCalls: () => void; onOpenCase: (id: string) => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const visit = useForegroundVisit(active);
  const [filter, setFilter] = useState<CallbackFilter>("all");
  const [showResolved, setShowResolved] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
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
  // The tapped request is open. A running action or its note editor also holds its own row open,
  // and a row with an action result stays open until that row is closed; other rows stay usable.
  const visibleIds = new Set(shown.map(item => item.id));
  const held = [state.editor?.id, state.pending?.id].filter((id): id is string => Boolean(id && visibleIds.has(id)));
  const resultRow = state.notice?.id && visibleIds.has(state.notice.id) ? state.notice.id : null;
  const isOpen = (id: string) => id === openId || id === resultRow || held.includes(id);
  // A note editor whose request this filter or page does not show stays reachable.
  const strayEditor = state.editor && !visibleIds.has(state.editor.id) ? state.editor : null;
  function toggle(id: string) {
    if (held.includes(id)) return;
    // Closing the row with a result is the only way a row dismisses that result.
    if (id === resultRow) { store.dismissNotice(); setOpenId(value => value === id ? null : value); return; }
    setOpenId(value => value === id ? null : id);
  }
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={s.content}
    refreshControl={<RefreshControl refreshing={state.loading && Boolean(state.counts)} onRefresh={() => { void store.refresh(); }} />}>
    {state.counts && <View style={s.summary}>
      <View style={s.summaryLine}>
        <Text accessibilityRole="header" style={s.summaryCount}>{state.counts.open ? waitingLabel(state.counts.open) : "Nikto nečaká"}</Text>
        {overdue !== null && overdue > 0 && <Tag text={"Po termíne " + overdue} tone="red" />}
      </View>
      <Text style={s.caption}>Vyžiadané klientom {state.counts.requested} · Zmeškané {state.counts.missed} · Zadané dispečerom {state.counts.manual}{state.counts.unknown ? " · Staršie " + state.counts.unknown : ""}{state.checkedAt ? " · overené " + formatTime(state.checkedAt) : ""}</Text>
    </View>}
    {!dialer.available && dialer.reason ? <Text style={[s.caption, s.inset]}>{dialer.reason}</Text> : null}
    <View style={[s.filters, s.inset]}>{callbackFilters.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === filter }}
      hitSlop={{ top: 6, bottom: 6 }} onPress={() => setFilter(item.id)} style={({ pressed }) => [s.filter, item.id === filter && s.filterSelected, pressed && { opacity: 0.75 }]}>
      <Text style={[s.filterText, item.id === filter && { color: colors.white }]}>{item.label}</Text></Pressable>)}</View>
    {state.notice && state.notice.id === null && <View style={s.inset}><Notice tone={state.notice.tone} message={state.notice.message} /></View>}
    {strayEditor && <View style={s.inset}><Card>
      <Text style={styles.text}>Máte rozpísanú poznámku k požiadavke, ktorá nie je v tomto zozname.</Text>
      {filter !== "all" && <Button label="Zobraziť všetky požiadavky" secondary onPress={() => setFilter("all")} />}
      <Button label="Zahodiť rozpísanú poznámku" secondary disabled={state.pending !== null} onPress={() => store.closeEditor()} />
    </Card></View>}
    {state.loading && !state.counts ? <Loading label="Načítavam spätné volania…" /> : state.error && !state.counts ? <View style={s.inset}><ErrorNotice message={state.error} onRetry={() => { void store.refresh(); }} /></View> : <>
      {state.error ? <View style={s.inset}><ErrorNotice message={state.error} onRetry={() => { void store.refresh(); }} /></View> : null}
      {shown.length === 0 ? <View style={s.inset}><Card><Text style={styles.text}>{state.open.length ? "Pre tento výber nie je žiadna otvorená požiadavka." : "Nikto nečaká na spätné volanie."}</Text>
        {filter !== "all" && state.nextCursor ? <Text style={styles.muted}>Ďalšie požiadavky ešte nie sú načítané.</Text> : null}</Card></View>
        : <Group>{shown.map((item, index) => <CallbackRow key={item.id} item={item} first={index === 0} now={now} state={state} dialer={dialer}
          expanded={isOpen(item.id)} held={held.includes(item.id)} onToggle={() => toggle(item.id)}
          onCall={() => { void call(item); }} onClaim={() => claim(item)} onOpenCase={() => { if (allowed() && item.caseId) onOpenCase(item.caseId); }}
          onEditor={status => store.openEditor(item.id, status)} onNotes={value => store.editNotes(value)} onCloseEditor={() => store.closeEditor()}
          onResolve={() => { if (allowed()) void store.resolve(); }} />)}</Group>}
      <View style={s.more}>
        {state.moreError ? <ErrorNotice message={state.moreError} onRetry={() => { void store.loadMore(); }} /> : null}
        {state.nextCursor && !state.moreError ? <Button label={state.loadingMore ? "Načítavam…" : "Ďalšie požiadavky"} secondary disabled={state.loadingMore} onPress={() => { void store.loadMore(); }} /> : null}
        {state.resolved.length > 0 && <Button label={(showResolved ? "Skryť" : "Zobraziť") + " uzavreté za 24 h (" + state.resolved.length + ")"} secondary onPress={() => setShowResolved(value => !value)} />}
      </View>
      {showResolved && state.resolved.length > 0 && <Group>{state.resolved.map((item, index) => <View key={item.id} style={s.resolved}>
        {index > 0 && <View style={s.separator} />}
        <View style={s.titleLine}><Text numberOfLines={1} style={s.title}>{item.name || formatNumber(item.number)}</Text>{item.resolvedAt ? <Text style={s.time}>{formatTime(item.resolvedAt)}</Text> : null}</View>
        <Text style={s.caption}>{callbackStatusLabels[item.status]}{item.claimant ? " · " + (item.claimant.mine ? "vy" : item.claimant.name ?? "dispečer") : ""}</Text>
        {item.notes ? <Text style={styles.text}>{item.notes}</Text> : null}
      </View>)}</Group>}
    </>}
  </ScrollView>;
}

function Notice({ tone, message }: { tone: "error" | "info"; message: string }) {
  return <View style={[s.notice, tone === "error" && s.noticeError]}><Text accessibilityRole="alert" style={[styles.text, tone === "error" && { color: colors.danger }]}>{message}</Text></View>;
}

/** Collapsed: who, how urgent, how long. Expanded: everything known and every action, each with a label. */
function CallbackRow({ item, first, now, state, dialer, expanded, held, onToggle, onCall, onClaim, onOpenCase, onEditor, onNotes, onCloseEditor, onResolve }: {
  item: MobileCallbackRequest; first: boolean; now: number; state: ReturnType<CallbackQueueStore["snapshot"]>; dialer: CallbackDialer; expanded: boolean;
  /** Held open by its running action or note editor. */
  held: boolean; onToggle: () => void;
  onCall: () => void; onClaim: () => void; onOpenCase: () => void; onEditor: (status: "done" | "cancelled") => void;
  onNotes: (value: string) => void; onCloseEditor: () => void; onResolve: () => void;
}) {
  const urgency = callbackUrgency(item, now), busy = state.pending !== null, mine = state.pending?.id === item.id;
  const editor = state.editor?.id === item.id ? state.editor : null;
  const Icon = item.origin === "requested" ? PhoneIncoming : PhoneMissed;
  const deadline = deadlineText(item, now);
  const title = item.name || formatNumber(item.number);
  const who = item.claimant ? (item.claimant.mine ? "Prevzali ste" : "Prevzal(a) " + (item.claimant.name ?? "iný dispečer")) : callbackStatusLabels[item.status];
  const origin = item.origin === "unknown" ? callbackOriginLabels.unknown : item.origin === "missed" ? "Zmeškaný hovor" : callbackOriginLabels[item.origin];
  return <View style={[s.row, expanded && s.rowOpen]}>
    {!first && <View style={s.separator} />}
    <Pressable accessibilityRole="button" accessibilityState={{ expanded, disabled: held }} accessibilityLabel={[title, deadline, origin, who, "čaká " + formatWait(item.createdAt, now)].filter(Boolean).join(", ")}
      disabled={held} onPress={onToggle} style={({ pressed }) => [s.head, pressed && { opacity: 0.7 }]}>
      <View style={[s.icon, urgency === "overdue" && { backgroundColor: palette.redSoft }, urgency === "due" && { backgroundColor: palette.orangeSoft }]}>
        <Icon size={15} strokeWidth={2.3} color={urgency === "overdue" ? palette.redText : urgency === "due" ? palette.orangeText : palette.label} accessible={false} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={s.titleLine}><Text numberOfLines={expanded ? undefined : 1} style={s.title}>{title}</Text><Text style={s.time}>{formatWait(item.createdAt, now)}</Text></View>
        <View style={s.meta}>{deadline ? <Tag text={deadline} tone={urgency === "overdue" ? "red" : urgency === "due" ? "orange" : "gray"} /> : null}
          <Text numberOfLines={1} style={s.metaText}>{origin} · {who}</Text></View>
      </View>
      {held ? null : expanded ? <ChevronUp size={18} color={palette.tertiaryLabel} accessible={false} /> : <ChevronDown size={18} color={palette.tertiaryLabel} accessible={false} />}
    </Pressable>
    {expanded && <View style={s.body}>
      {item.name ? <Text selectable style={styles.text}>{formatNumber(item.number)}</Text> : null}
      {/* The collapsed line may be cut; the open row says it in full. */}
      <Text style={s.caption}>{callbackOriginLabels[item.origin]} · {who}</Text>
      {item.originDetail ? <Text style={s.caption}>{item.originDetail}</Text> : null}
      {/* The origin already names missed, requested and manual rows; older rows keep their route. */}
      {item.origin === "unknown" || item.lineLabel || item.partnerName ? <Text style={s.caption}>{[item.origin === "unknown" ? item.sourceLabel : null, item.lineLabel ?? item.partnerName].filter(Boolean).join(" · ")}</Text> : null}
      <Text style={[s.caption, urgency !== "fresh" && { color: urgency === "overdue" ? palette.redText : palette.orangeText }]}>Čaká {formatWait(item.createdAt, now)}{deadline ? " · " + deadline : ""}</Text>
      {item.lastCalledAt ? <Text style={s.caption}>Naposledy volané {formatTime(item.lastCalledAt)}</Text> : null}
      {item.notes ? <Text style={styles.text}>{item.notes}</Text> : null}
      {state.notice?.id === item.id && <Notice tone={state.notice.tone} message={state.notice.message} />}
      {item.actions.blockedReason ? <Text style={s.caption}>{item.actions.blockedReason}</Text> : null}
      {editor ? <View style={{ gap: 10 }}>
        <Text style={styles.label}>{editor.status === "done" ? "Poznámka k vybaveniu (nepovinné)" : "Dôvod zrušenia (nepovinné)"}</Text>
        <TextInput accessibilityLabel={editor.status === "done" ? "Poznámka k vybaveniu" : "Dôvod zrušenia"} value={editor.notes} onChangeText={onNotes} multiline maxLength={MOBILE_CALLBACK_NOTE_LIMIT}
          editable={!busy} placeholder="Napríklad: dovolané, odťah objednaný" placeholderTextColor={colors.muted} selectionColor={colors.brand} style={[styles.input, { minHeight: 88, textAlignVertical: "top" }]} />
        <Text style={styles.muted}>{editor.notes.length}/{MOBILE_CALLBACK_NOTE_LIMIT}</Text>
        <Button primary label={mine && state.pending?.action === "resolve" ? "Ukladám…" : editor.status === "done" ? "Potvrdiť vybavenie" : "Potvrdiť zrušenie"} disabled={busy} onPress={onResolve} />
        <Button label="Späť bez uzavretia" secondary disabled={busy} onPress={onCloseEditor} />
      </View> : <View style={{ gap: 8 }}>
        {item.actions.call && <Button primary label={mine && state.pending?.action === "call" ? "Overujem číslo…" : "Zavolať späť"} disabled={busy || !dialer.available} onPress={onCall} />}
        {item.actions.claim && <Button label={mine && state.pending?.action === "claim" ? "Preberám…" : item.actions.takeover ? "Prevziať od kolegu" : "Prevziať"} secondary disabled={busy} onPress={onClaim} />}
        {item.actions.resolve && <View style={styles.row}>
          <View style={{ flex: 1 }}><Button label="Vybavené" secondary disabled={busy} onPress={() => onEditor("done")} /></View>
          <View style={{ flex: 1 }}><Button label="Zrušiť" secondary disabled={busy} onPress={() => onEditor("cancelled")} /></View>
        </View>}
        {item.caseId ? <Button label="Otvoriť prípad" secondary onPress={onOpenCase} /> : null}
      </View>}
    </View>}
  </View>;
}

const s = StyleSheet.create({
  content: { paddingTop: 6, paddingBottom: NAVIGATION_CONTENT_BOTTOM, gap: space.m },
  inset: { paddingHorizontal: space.l },
  summary: { paddingHorizontal: space.l, gap: 2 },
  summaryLine: { flexDirection: "row", alignItems: "center", gap: space.s, flexWrap: "wrap" },
  summaryCount: { ...type.headline, color: palette.label },
  caption: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel },
  filters: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  filter: { borderRadius: 16, minHeight: 32, backgroundColor: colors.white, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(60,60,67,0.16)", paddingHorizontal: 12, paddingVertical: 6, alignItems: "center", justifyContent: "center" },
  filterText: { fontSize: 13, lineHeight: 17, fontWeight: "600", color: colors.ink },
  filterSelected: { backgroundColor: colors.ink },
  row: { backgroundColor: palette.card },
  rowOpen: { backgroundColor: "#FBFBFD" },
  separator: { position: "absolute", top: 0, left: 50, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator, zIndex: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: space.m, paddingVertical: 8, minHeight: 56 },
  icon: { width: 28, height: 28, borderRadius: 8, backgroundColor: palette.fill, alignItems: "center", justifyContent: "center" },
  titleLine: { flexDirection: "row", alignItems: "baseline", gap: space.s },
  title: { ...type.rowTitle, color: palette.label, flex: 1 },
  time: { ...type.caption, color: palette.secondaryLabel, fontVariant: ["tabular-nums"] },
  meta: { flexDirection: "row", alignItems: "center", gap: 6, overflow: "hidden" },
  metaText: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, flexShrink: 1 },
  body: { paddingLeft: 50, paddingRight: space.m, paddingBottom: space.m, gap: 6 },
  more: { paddingHorizontal: space.l, gap: space.s },
  resolved: { paddingHorizontal: space.m, paddingVertical: 9, gap: 2, backgroundColor: palette.card },
  notice: { backgroundColor: colors.notice, borderWidth: 1, borderColor: colors.noticeBorder, borderRadius: 16, padding: 12 },
  noticeError: { backgroundColor: "#FFF0EF", borderColor: "#F4C7C3" },
});
