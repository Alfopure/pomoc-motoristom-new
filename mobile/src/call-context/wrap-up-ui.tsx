import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MOBILE_CALL_NOTE_LIMIT, MOBILE_CALL_OUTCOMES, MOBILE_CALLBACK_MINUTES, type MobileCallWrapUp } from "../../../src/lib/mobile-call-wrap-up";
import { formatTime } from "../lib/display";
import { MobileApiError } from "../lib/api";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "../ui";
import { Choice } from "../cases/form";
import type { CallWrapUpApi } from "./wrap-up-api";
import { WrapUpStore } from "./wrap-up-store";

export type CaseSearchResult = { id: string; caseNumber: string; statusLabel: string; contactName: string | null; licensePlate: string | null };
export type WrapUpDependencies = { api: CallWrapUpApi; uuid: () => string; searchCases: (q: string, signal?: AbortSignal) => Promise<CaseSearchResult[]> };

export function WrapUpSection({ deps, callId, active, allowed, onLinked }: {
  deps: WrapUpDependencies; callId: string; active: boolean; allowed: () => boolean; onLinked: () => void;
}) {
  const store = useMemo(() => new WrapUpStore(deps.api, callId, deps.uuid), [deps.api, deps.uuid, callId]);
  // The parent's reload changes identity per render; the store keeps the latest one.
  useLayoutEffect(() => { store.setLinkedListener(onLinked); }, [store, onLinked]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [picking, setPicking] = useState(false);
  useEffect(() => { store.setActive(active); if (active) void store.refresh(); }, [store, active]);
  useEffect(() => () => store.dispose(), [store]);
  const data = state.data, editor = state.editor;
  function confirmLink(id: string, caseNumber: string) {
    if (!allowed()) return;
    Alert.alert(data?.linkedCaseId ? "Zmeniť priradený prípad?" : "Priradiť hovor k prípadu?",
      (data?.linkedCase ? "Hovor je teraz pri prípade " + data.linkedCase.caseNumber + ". " : "") + "Hovor sa priradí k prípadu " + caseNumber + " a zapíše sa do jeho časovej osi.", [
        { text: "Zrušiť", style: "cancel" },
        { text: "Priradiť", onPress: () => { if (allowed()) void store.link(id).then(done => { if (done) setPicking(false); }); } },
      ]);
  }
  return <View style={{ gap: 12 }}>
    <Text style={styles.subheading}>Po hovore</Text>
    {state.loading && !data && <Loading label="Načítavam výsledok hovoru…" />}
    {state.error && !data && <ErrorNotice message={state.error} onRetry={() => { void store.refresh(); }} />}
    {state.notice && <View style={[s.notice, state.notice.tone === "error" && s.noticeError]}>
      <Text accessibilityRole="alert" style={[styles.text, state.notice.tone === "error" && { color: colors.danger }]}>{state.notice.message}</Text>
    </View>}
    {data && <Card>
      <Text style={styles.label}>Výsledok hovoru</Text>
      {data.outcome ? <View style={{ gap: 4 }}>
        <Text style={styles.subheading}>{data.outcome.label}{data.outcome.callbackMinutes ? " · o " + data.outcome.callbackMinutes + " min" : ""}</Text>
        {data.outcome.note && <Text selectable style={styles.text}>{data.outcome.note}</Text>}
        {data.outcome.at && <Text style={styles.muted}>Zapísané {formatTime(data.outcome.at)}</Text>}
      </View> : <Text style={styles.muted}>Výsledok zatiaľ nie je zapísaný.</Text>}
      {editor ? <View style={{ gap: 10 }}>
        <View style={s.choices}>{MOBILE_CALL_OUTCOMES.map(item => <Choice key={item.value} label={item.label} selected={editor.outcome === item.value} disabled={state.saving}
          onPress={() => store.choose(item.value)} />)}</View>
        {editor.outcome === "callback" && <View style={{ gap: 8 }}>
          <Text style={styles.label}>Zavolať naspäť o</Text>
          <View style={s.choices}>{MOBILE_CALLBACK_MINUTES.map(minutes => <Choice key={minutes} label={minutes < 60 ? minutes + " min" : minutes / 60 + " h"} selected={editor.callbackMinutes === minutes}
            disabled={state.saving} onPress={() => store.chooseMinutes(minutes)} />)}</View>
          <Text style={[styles.muted, data.callbackScheduling === "unavailable" && { color: colors.danger }]}>{data.callbackScheduling === "queue"
            ? "Požiadavka sa zaradí do spätných volaní a pridelí sa vám." : data.callbackScheduling === "case_task"
              ? "K prípadu sa vytvorí úloha Zavolať späť s termínom." : "Bez priradeného prípadu sa spätné volanie nedá naplánovať. Najprv priraďte hovor k prípadu."}</Text>
        </View>}
        <TextInput accessibilityLabel="Poznámka k hovoru" value={editor.note} onChangeText={value => store.editNote(value)} multiline maxLength={MOBILE_CALL_NOTE_LIMIT}
          editable={!state.saving} placeholder="Poznámka k hovoru (nepovinné)" placeholderTextColor={colors.muted} selectionColor={colors.brand}
          style={[styles.input, { minHeight: 88, textAlignVertical: "top" }]} />
        <Text style={styles.muted}>{editor.note.length}/{MOBILE_CALL_NOTE_LIMIT} · poznámku uvidí aj web v detaile a histórii hovoru{data.linkedCase ? " a v časovej osi prípadu" : ""}.</Text>
        <Button label={state.saving ? "Ukladám…" : "Uložiť výsledok"} disabled={!store.canSave()} onPress={() => { if (allowed()) void store.save(); }} />
        <Button label="Zrušiť úpravu" secondary disabled={state.saving} onPress={() => store.closeEditor()} />
      </View> : <Button label={data.outcome ? "Zmeniť výsledok" : "Zapísať výsledok"} secondary onPress={() => store.openEditor()} />}
    </Card>}
    {data && <Card>
      <Text style={styles.label}>Priradenie k prípadu</Text>
      <Text style={styles.muted}>{data.linkedCase ? "Hovor je pri prípade " + data.linkedCase.caseNumber + ". Môžete ho presunúť k inému prípadu."
        : data.linkedCaseId ? "Priradený prípad nie je dostupný." : "Hovor zatiaľ nie je priradený k prípadu."}</Text>
      {!picking ? <Button label={data.linkedCaseId ? "Zmeniť priradený prípad" : "Priradiť k prípadu"} secondary disabled={Boolean(state.linking)} onPress={() => setPicking(true)} />
        : <CasePicker data={data} searchCases={deps.searchCases} active={active} linking={state.linking} onPick={confirmLink} onClose={() => setPicking(false)} />}
    </Card>}
  </View>;
}

function CasePicker({ data, searchCases, active, linking, onPick, onClose }: {
  data: MobileCallWrapUp; searchCases: WrapUpDependencies["searchCases"]; active: boolean; linking: string | null;
  onPick: (id: string, caseNumber: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; items: CaseSearchResult[]; error: string | null } | null>(null);
  const trimmed = query.trim();
  useEffect(() => {
    if (!active || trimmed.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchCases(trimmed, controller.signal)
        .then(items => { if (!controller.signal.aborted) setResults({ query: trimmed, items: items.filter(item => item.id !== data.linkedCaseId), error: null }); })
        .catch(error => { if (!controller.signal.aborted) setResults({ query: trimmed, items: [], error: error instanceof MobileApiError ? error.message : "Prípady sa nepodarilo vyhľadať." }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, trimmed, searchCases, data.linkedCaseId]);
  const current = results?.query === trimmed ? results : null;
  return <View style={{ gap: 10 }}>
    {data.suggestions.length > 0 && <>
      <Text style={styles.label}>Návrhy podľa čísla</Text>
      {data.suggestions.map(item => <CaseRow key={item.caseId} title={item.caseNumber} subtitle={[item.statusLabel, item.contactName, item.reason === "previous_call" ? "skorší hovor z čísla" : null].filter(Boolean).join(" · ")}
        muted={!item.open} busy={linking === item.caseId} disabled={Boolean(linking)} onPress={() => onPick(item.caseId, item.caseNumber)} />)}
    </>}
    {!data.matchesAvailable && <Text style={styles.muted}>Návrhy podľa čísla sú teraz nedostupné; prípad môžete vyhľadať.</Text>}
    {data.matchesAvailable && data.number && !data.suggestions.length && <Text style={styles.muted}>K tomuto číslu nepoznáme ďalší prípad.</Text>}
    <TextInput accessibilityLabel="Hľadať otvorený prípad" value={query} onChangeText={setQuery} maxLength={160} autoCorrect={false}
      placeholder="Číslo prípadu, meno alebo EČV" placeholderTextColor={colors.muted} selectionColor={colors.brand} style={styles.input} />
    {trimmed.length >= 2 && !current && <Loading label="Hľadám prípady…" />}
    {current?.error && <ErrorNotice message={current.error} />}
    {current && !current.error && !current.items.length && <Text style={styles.muted}>Žiadny otvorený prípad pre toto hľadanie.</Text>}
    {current?.items.map(item => <CaseRow key={item.id} title={item.caseNumber} subtitle={[item.statusLabel, item.contactName, item.licensePlate].filter(Boolean).join(" · ")}
      busy={linking === item.id} disabled={Boolean(linking)} onPress={() => onPick(item.id, item.caseNumber)} />)}
    <Button label="Zavrieť výber prípadu" secondary disabled={Boolean(linking)} onPress={onClose} />
  </View>;
}

function CaseRow({ title, subtitle, muted, busy, disabled, onPress }: { title: string; subtitle: string; muted?: boolean; busy: boolean; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={"Priradiť k prípadu " + title} accessibilityState={{ disabled, busy }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }, disabled && !busy && { opacity: 0.6 }]}>
    <Text style={[styles.text, { fontWeight: "600" }, muted && { color: colors.muted }]}>{busy ? "Priraďujem… " : ""}{title}</Text>
    {Boolean(subtitle) && <Text style={styles.muted}>{subtitle}</Text>}
  </Pressable>;
}

const s = StyleSheet.create({
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  row: { borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceMuted, padding: 14, gap: 3, minHeight: 52 },
  notice: { backgroundColor: colors.notice, borderWidth: 1, borderColor: colors.noticeBorder, borderRadius: 16, padding: 12 },
  noticeError: { backgroundColor: "#FFF0EF", borderColor: "#F4C7C3" },
});
