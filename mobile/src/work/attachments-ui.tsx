import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { KeyboardAvoidingView, Linking, Modal, Platform, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useAndroidBack } from "../lib/use-android-back";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "../ui";
import { formatTime } from "../lib/display";
import type { WorkStore } from "./store";
import { prepareDocumentPicker, preparePhotoPicker } from "./pickers";
import type { PickedFile } from "./attachments";
import { workError } from "./ui-shared";

const sizeLabel = (bytes: number) => bytes < 1024 ? bytes + " B" : (bytes / 1024).toFixed(0) + " KiB";
type Chooser = { photo?: (camera: boolean) => Promise<PickedFile | null>; document?: () => Promise<PickedFile | null> };
export function Attachments({ store, caseId, queryKey, active, onBack }: { store: WorkStore; caseId: string; queryKey: string[]; active: boolean; onBack: () => void }) {
  const draft = store.attachment(caseId), state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  const [form, setForm] = useState(false), [busy, setBusy] = useState(false), [chooser, setChooser] = useState<Chooser | null>(null), [error, setError] = useState<string | null>(null);
  const locked = useRef(false), alive = useRef(true), visible = useRef(active), scroll = useRef<ScrollView>(null);
  useEffect(() => { visible.current = active; }, [active]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (state.error || state.status === "saved") scroll.current?.scrollTo({ y: 0, animated: true }); }, [state.error, state.status]);
  const query = useQuery({ queryKey: [...queryKey, "attachments", caseId], queryFn: async ({ signal }) => { const requestedAt = Date.now(); return { ...await store.api.attachments(caseId, signal), requestedAt }; }, enabled: active });
  useEffect(() => {
    if (active && !form && query.isSuccess && !query.isFetching) draft.reviewList(query.data, query.data.requestedAt);
  }, [active, form, query.isSuccess, query.isFetching, query.data, draft]);
  async function prepare(photo: boolean) {
    if (locked.current || draft.snapshot().status !== "editing") return; locked.current = true; setBusy(true); setError(null);
    try { const ready: Chooser = photo ? { photo: await preparePhotoPicker() } : { document: await prepareDocumentPicker() }; if (alive.current) setChooser(ready); }
    catch (error) { if (alive.current) setError(workError(error)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function pick(action: () => Promise<PickedFile | null>) {
    if (locked.current || draft.snapshot().status !== "editing") return; locked.current = true; setBusy(true); setChooser(null); setError(null);
    try { const file = await action(); if (alive.current && file) draft.select(file); }
    catch (error) { if (alive.current) setError(workError(error)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function open(id: string) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(null);
    try { const asset = await store.api.download(caseId, id); if (alive.current && visible.current) await Linking.openURL(asset.url); }
    catch (error) { if (alive.current) setError(workError(error)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const saving = state.status === "saving", editing = state.status === "editing";
  const back = () => { if (draft.snapshot().status !== "saving" && !locked.current) { if (form) setForm(false); else onBack(); } };
  useAndroidBack(active, back, saving || busy);
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => { if (active) void query.refetch(); }} />}>
      <Button label={form ? "Späť na prílohy" : "Späť na prípad"} secondary disabled={saving || busy} onPress={back} />
      <Text style={styles.heading}>{form ? "Pridať prílohu" : "Prílohy prípadu"}</Text>
      {error && <ErrorNotice message={error} />}{state.error && <ErrorNotice message={state.error} />}
      {state.status === "saved" && <Card><Text accessibilityRole="alert" style={styles.subheading}>Príloha je uložená.</Text><Text style={styles.text}>{state.receipt?.attachment.fileName}</Text></Card>}
      {state.status === "uncertain" && (state.coldMissingFile ? <Card>
        <Text style={styles.subheading}>Pôvodný súbor už nie je v pamäti.</Text>
        <Text style={styles.text}>Najprv obnovte a skontrolujte prílohy. Rovnaký názov súboru nepotvrdzuje, že pôvodné priloženie uspelo. Nový výber môže vytvoriť ďalšiu prílohu.</Text>
        <Button label="Obnoviť a skontrolovať prílohy" secondary disabled={!active || query.isFetching} onPress={() => { setForm(false); void query.refetch(); }} />
        {!form && <Button label="Skontroloval som prílohy; povoliť nový výber" disabled={!state.reviewedList || query.isError || query.isFetching} onPress={() => { draft.allowNewSelection(); setForm(true); }} />}
      </Card> : <Button label="Overiť pôvodné priloženie" disabled={busy} onPress={() => { void draft.reconcile(); }} />)}
      {form ? <>
        <Text style={styles.muted}>Fotografia sa priloží ako zmenšená JPEG kópia do 2048 px. Dokument JPEG, PNG alebo PDF môže mať najviac 3 MiB.</Text>
        <Button label="Fotografia alebo fotoaparát" secondary disabled={!editing || busy} onPress={() => { void prepare(true); }} />
        <Button label="Vybrať dokument" secondary disabled={!editing || busy} onPress={() => { void prepare(false); }} />
        {busy && <Loading label="Pripravujem prílohu…" />}
        {editing && state.coldMissingFile && <Text style={styles.muted}>Súbor sa do konceptu neukladá. Vyberte ho znova; poznámka zostala zachovaná.</Text>}
        {state.selected && <Card><Text style={styles.subheading}>{state.selected.fileName}</Text><Text style={styles.muted}>{state.selected.mimeType} · {sizeLabel(state.selected.sizeBytes)}</Text></Card>}
        <View><Text style={styles.label}>Poznámka k prílohe</Text><TextInput accessibilityLabel="Poznámka k prílohe" value={state.note} onChangeText={v => draft.editNote(v)} editable={editing} maxLength={2000} multiline style={[styles.input, { minHeight: 100 }]} /></View>
        {query.isError && <ErrorNotice message={workError(query.error)} onRetry={() => { void query.refetch(); }} />}
        <Button label={saving ? "Prikladám…" : "Priložiť k prípadu"} disabled={!editing || busy || !state.selected || state.coldMissingFile || !query.data || query.isError || query.isFetching}
          onPress={() => { if (query.data) void draft.save(query.data.caseRevision); }} />
      </> : <>
        <Button label={state.status === "uncertain" || state.selected && state.status !== "saved" ? "Rozpracovaná príloha" : "Pridať prílohu"} onPress={() => { draft.reset(); setForm(true); }} disabled={saving} />
        {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={workError(query.error)} onRetry={() => { void query.refetch(); }} /> : <>
          {query.data?.attachments.length === 0 && <Card><Text style={styles.text}>Zatiaľ bez príloh.</Text></Card>}
          {query.data?.attachments.map(item => <Card key={item.id}><Text style={styles.subheading}>{item.fileName}</Text>
            <Text style={styles.muted}>{item.category === "photo" ? "Fotografia" : item.category === "video" ? "Video" : "Dokument"}{item.sizeBytes !== null ? " · " + sizeLabel(item.sizeBytes) : ""}{item.createdAt ? " · " + formatTime(item.createdAt) : ""}</Text>
            {item.note && <Text style={styles.text}>{item.note}</Text>}<Button label={"Otvoriť " + item.fileName} secondary disabled={!item.downloadable || busy} onPress={() => { void open(item.id); }} />
            {!item.downloadable && <Text style={styles.muted}>Tento súbor nie je dostupný na otvorenie.</Text>}</Card>)}
        </>}
      </>}
    </ScrollView>
    <Modal visible={active && !!chooser} transparent animationType="fade" onRequestClose={() => setChooser(null)}><View style={{ flex: 1, justifyContent: "center", padding: 20, backgroundColor: "rgba(0,0,0,0.5)" }}>
      <View accessibilityViewIsModal style={{ backgroundColor: colors.white, padding: 20, borderRadius: 20, gap: 15 }}><Text style={styles.subheading}>Zdroj prílohy</Text>
        {chooser?.photo && <><Button label="Otvoriť galériu" onPress={() => { if (chooser.photo) void pick(() => chooser.photo!(false)); }} /><Button label="Otvoriť fotoaparát" onPress={() => { if (chooser.photo) void pick(() => chooser.photo!(true)); }} /></>}
        {chooser?.document && <Button label="Otvoriť súbory" onPress={() => { if (chooser.document) void pick(chooser.document); }} />}
        <Button label="Zrušiť výber" secondary onPress={() => setChooser(null)} />
      </View></View></Modal>
  </KeyboardAvoidingView>;
}
