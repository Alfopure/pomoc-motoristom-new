import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import type { TowingCreateInput } from "../../../src/domain/towing/creation";
import type { TowingFields } from "../../../src/domain/towing/types";
import { towingCreateFieldNames } from "../../../src/domain/towing/creation";
import { createDeliveryCommandStorage } from "../delivery/command-storage";
import { formLayout, ChoiceField, FormSection, FormText } from "../design/form";
import { useAndroidBack } from "../lib/use-android-back";
import { useShellBack } from "../shell/back";
import { Button, ErrorNotice, Loading, styles } from "../ui";
import { Chip, StorageNotice } from "./parts";
import type { FieldWorkSession } from "./session";
import { TowingFieldsForm, TowingPicker } from "./towing-form";

export function towingInputFields(value: TowingFields): TowingFields {
  const fields = Object.fromEntries(towingCreateFieldNames.filter(key => value[key] !== undefined).map(key => [key, value[key]])) as unknown as TowingFields;
  if (fields.realizedItems) fields.realizedItems = fields.realizedItems.map(({ parkingName: _parkingName, parkingAddress: _parkingAddress, ...item }) => item);
  return fields;
}
type CreationDraft = { version: 1; targetId: string; commandId: string; fields: TowingFields; driverId?: string; completed: boolean };
const blank = (): CreationDraft => ({ version: 1, targetId: randomUUID(), commandId: randomUUID(), completed: false,
  fields: { serviceType: "tow", subjectType: "vehicle", subjectDescription: "", pickup: "", plannedAt: new Date().toISOString(), requesterType: "selfpayer" } });
const isId = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
function restored(value: unknown): CreationDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Koncept nemá platný formát.");
  const d = value as CreationDraft;
  if (d.version !== 1 || !isId(d.targetId) || !isId(d.commandId) || typeof d.completed !== "boolean"
    || !d.fields || typeof d.fields !== "object" || typeof d.fields.pickup !== "string" || typeof d.fields.subjectDescription !== "string"
    || d.driverId !== undefined && !isId(d.driverId)) throw new Error("Koncept nemá platný formát.");
  if (JSON.stringify(d).length > 90000) throw new Error("Koncept presahuje povolenú veľkosť.");
  return d;
}

/** The draft and immutable pending command are both scoped to the verified member. */
export function TowingCreate({ session, office = false, active, visible, onBack, onCreated }: {
  session: FieldWorkSession; office?: boolean; active: boolean; visible: boolean; onBack: () => void; onCreated: (id: string, own: boolean) => void;
}) {
  const storage = useMemo(() => createDeliveryCommandStorage(), []);
  const key = session.commands.key + ".towing-draft." + (office ? "office" : "self");
  const [draft, setDraft] = useState<CreationDraft>(blank), [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [valid, setValid] = useState(true), [saving, setSaving] = useState(false);
  const state = useSyncExternalStore(session.commands.subscribe, session.commands.snapshot, session.commands.snapshot);
  const options = useQuery({ queryKey: [...session.key, "towing-options", session.memberId], queryFn: ({ signal }) => session.api.towingOptions(signal), enabled: active && visible });
  const pending = state.pending.find(item => item.target.kind === "towing-create" && (item.command as TowingCreateInput).mode === (office ? "office" : "self"));
  const target = { kind: "towing-create" as const, id: pending?.target.id ?? draft.targetId };
  const busy = saving || state.busy || !state.ready || !state.enabled;
  const locked = busy || Boolean(pending);
  useEffect(() => {
    let live = true;
    void storage.getItem(key).then(raw => { if (!live) return; if (raw) setDraft(restored(JSON.parse(raw))); setLoaded(true); setStorageError(null); })
      .catch(() => { if (live) { setLoaded(false); setStorageError("Rozpracovaný odťah sa nepodarilo načítať. Obnovte načítanie pred novým zadaním."); } });
    return () => { live = false; };
  }, [key, storage]);
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    void storage.setItem(key, JSON.stringify(draft)).then(() => { if (live) setStorageError(null); })
      .catch(() => { if (live) setStorageError("Koncept sa nepodarilo uložiť do telefónu. Pred odoslaním skúste uloženie znova."); });
    return () => { live = false; };
  }, [draft, key, loaded, storage]);
  useShellBack(visible, office ? "Kniha odťahov" : "Moja práca", onBack, busy);
  useAndroidBack(active && visible, () => { if (!busy) onBack(); });
  async function accepted(result: { targetId: string } | null) {
    if (!result) return;
    // An acknowledgement still waiting to leave protected local storage is replayed before another create.
    if (!session.commands.pendingFor(target)) {
      try { await storage.removeItem(key); } catch { setStorageError("Odťah je vytvorený, ale miestny koncept sa nepodarilo uzavrieť. Overte rovnaké zadanie pred ďalším odťahom."); return; }
    }
    onCreated(result.targetId, !office);
  }
  async function submit() {
    if (locked || !loaded || !valid) return;
    setSaving(true); setError(null);
    try {
      await storage.setItem(key, JSON.stringify(draft));
      const command: TowingCreateInput = { commandId: draft.commandId, targetId: draft.targetId, mode: office ? "office" : "self", fields: towingInputFields(draft.fields),
        ...(office ? { ...(draft.driverId ? { driverId: draft.driverId } : {}), completed: draft.completed } : {}) };
      await accepted(await session.commands.start<{ targetId: string }>(target, command, office && draft.completed ? "Zaevidovať vykonaný odťah" : "Vytvoriť odťah"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Odťah sa nepodarilo pripraviť."); }
    finally { setSaving(false); }
  }
  return <ScrollView contentContainerStyle={formLayout.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
    <View style={formLayout.head}><Text accessibilityRole="header" style={styles.heading}>Nový odťah</Text><Text style={styles.muted}>{office ? "Zákazka odťahovej kancelárie" : "Vlastná zákazka · vodič ste vy"}</Text></View>
    <StorageNotice commands={session.commands} state={state} />
    {storageError || error || options.isError ? <View style={formLayout.notices}>
      {storageError ? <ErrorNotice message={storageError} onRetry={() => { const retry = loaded ? storage.setItem(key, JSON.stringify(draft)) : storage.getItem(key).then(raw => { if (raw) setDraft(restored(JSON.parse(raw))); setLoaded(true); }); void retry.then(() => setStorageError(null)).catch(() => setStorageError("Koncept sa stále nepodarilo bezpečne načítať alebo uložiť.")); }} /> : null}
      {error ? <ErrorNotice message={error} /> : null}
      {options.isError ? <ErrorNotice message="Výbery sa nepodarilo načítať." onRetry={() => { void options.refetch(); }} /> : null}
    </View> : null}
    {pending ? <FormSection title="Overenie pôvodného zadania"><FormText>{pending.message ?? "Odťah už mohol vzniknúť. Pokračujte overením rovnakého zadania."}</FormText>
      <View><Button secondary label={busy ? "Overujem…" : "Overiť rovnaký odťah"} disabled={busy} onPress={() => { void session.commands.retry<{ targetId: string }>(target).then(accepted); }} /></View>
      {pending.status === "rejected" ? <View><Button secondary label="Upraviť odmietnuté zadanie" disabled={busy} onPress={() => { void options.refetch().then(async result => { if (!result.isSuccess) return; await session.commands.dismiss(target); if (!session.commands.pendingFor(target)) setDraft(current => ({ ...current, commandId: randomUUID() })); }); }} /></View> : null}
    </FormSection> : null}
    {!loaded ? <Loading label="Načítavam rozpracovaný odťah…" /> : <>
      {office ? <FormSection title="Zadanie">
        <ChoiceField label="Spôsob evidencie"><Chip onCard label="Nový / plánovaný odťah" selected={!draft.completed} disabled={locked} onPress={() => setDraft(current => ({ ...current, completed: false }))} /><Chip onCard label="Doplniť vykonaný odťah" selected={draft.completed} disabled={locked} onPress={() => setDraft(current => ({ ...current, completed: true }))} /></ChoiceField>
        <TowingPicker label="Vodič" value={draft.driverId} items={options.data?.members ?? []} disabled={locked} onChange={driverId => setDraft(current => ({ ...current, driverId }))} empty="Zatiaľ nepridelené" />
      </FormSection> : null}
      <TowingFieldsForm key={draft.completed ? "completed" : "planned"} value={draft.fields} onChange={fields => setDraft(current => ({ ...current, fields }))} options={options.data} disabled={locked} actualTimes={office && draft.completed} onValidityChange={setValid} />
      <FormSection><FormText tone="muted">Rozpracované údaje ostávajú uložené pre tento účet v tomto zariadení. Vrátiť sa môžete cez Nový odťah.</FormText></FormSection>
      <View style={formLayout.actions}><Button primary label={busy ? "Ukladám…" : office && draft.completed ? "Zaevidovať vykonaný odťah" : "Vytvoriť odťah"} disabled={locked || !valid || options.isPending || options.isError} onPress={() => { void submit(); }} /></View>
    </>}
  </ScrollView>;
}
