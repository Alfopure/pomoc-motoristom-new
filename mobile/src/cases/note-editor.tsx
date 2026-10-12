import { useSyncExternalStore } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useAndroidBack } from "../lib/use-android-back";
import type { MobileCaseNoteAdded } from "../../../src/lib/mobile-api";
import { Button, Card, ErrorNotice, styles } from "../ui";
import type { CaseNoteDraft } from "./notes";

export function CaseNoteSavedNotice({ draft, onUpdated }: { draft: CaseNoteDraft; onUpdated?: (receipt: MobileCaseNoteAdded) => void }) {
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  if (state.status !== "saved" || !state.receipt) return null;
  const needsAudit = state.receipt.warnings.some(warning => warning.code === "case_note_audit_incomplete");
  async function repair() {
    const receipt = await draft.repairAudit();
    if (receipt) onUpdated?.(receipt);
  }
  return <Card>
    <Text style={styles.subheading}>Poznámka je uložená</Text>
    {state.receipt.warnings.map((warning, index) => <Text key={index} style={styles.text}>{warning.message}</Text>)}
    {state.error && <ErrorNotice message={state.error} />}
    {needsAudit && <Button label={state.repairing ? "Overujem audit…" : "Overiť audit poznámky"} disabled={state.repairing} onPress={() => { void repair(); }} />}
  </Card>;
}

export function CaseNoteForm({ draft, active, onBack, onSaved }: { active: boolean; draft: CaseNoteDraft; onBack: () => void; onSaved: (receipt: MobileCaseNoteAdded) => void }) {
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  const locked = state.status !== "editing";
  const back = () => { const current = draft.snapshot(); if (current.status !== "saving" && !current.repairing) onBack(); };
  useAndroidBack(active, back, state.status === "saving" || state.repairing);
  async function save(reconcile = false) {
    Keyboard.dismiss();
    const receipt = await (reconcile ? draft.reconcile() : draft.submit());
    if (receipt) onSaved(receipt);
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Button label="Späť na prípad" secondary disabled={state.status === "saving" || state.repairing} onPress={back} />
      <Text style={styles.heading}>Pridať poznámku</Text>
      <Text style={styles.text}>Poznámka sa pridá do histórie prípadu spolu s vaším menom a časom.</Text>
      <View><Text style={styles.label}>Poznámka</Text><TextInput accessibilityLabel="Nová poznámka prípadu" value={state.note} onChangeText={value => draft.edit(value)}
        editable={!locked} multiline maxLength={10_000} textAlignVertical="top" style={[styles.input, { minHeight: 150 }]} /></View>
      {state.error && state.status !== "saved" && <ErrorNotice message={state.error} />}
      {state.status === "uncertain" ? <Button label="Overiť uloženie poznámky" onPress={() => { void save(true); }} />
        : state.status === "saved" && state.receipt ? <View style={{ gap: 12 }}>
          <CaseNoteSavedNotice draft={draft} />
          <Button label="Otvoriť prípad" disabled={state.repairing} onPress={() => onSaved(state.receipt!)} />
        </View>
          : <Button label={state.status === "saving" ? "Ukladám…" : "Uložiť poznámku"} disabled={locked || !state.note.trim()} onPress={() => { void save(); }} />}
    </ScrollView>
  </KeyboardAvoidingView>;
}
