import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useAndroidBack } from "../lib/use-android-back";
import { Button, Card, ErrorNotice, styles } from "../ui";
import { CaseEdit, changedFields } from "./edit";
import type { CasesApi } from "./api";
import { CaseMapFrame } from "./map-frame";
import { describeCurrentPlace, describeSelectedPlace } from "./location";
import { Choice, fields, jobTypes, priorities } from "./form";

export function CaseEditor({ api, edit, active, onBack, onSaved }: { api: CasesApi; edit: CaseEdit; active: boolean; onBack: () => void; onSaved: () => void }) {
  const state = useSyncExternalStore(edit.subscribe, edit.snapshot, edit.snapshot);
  const back = () => { if (edit.snapshot().status !== "saving") onBack(); };
  useAndroidBack(active, back, state.status === "saving");
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (active && (state.error || ["uncertain", "conflict", "blocked", "committed", "saved"].includes(state.status))) scroll.current?.scrollTo({ y: 0, animated: false });
  }, [active, state.status, state.error]);
  const [mapTarget, setMapTarget] = useState<"pickup" | "destination" | null>(null);
  const [addressAcknowledged, setAddressAcknowledged] = useState("");
  useEffect(() => { edit.setActive(active); return () => edit.setActive(false); }, [edit, active]);
  useEffect(() => {
    if (state.status === "committed") onSaved();
  }, [state.status, onSaved]);
  useEffect(() => {
    if (active && state.status === "committed" && !state.error && !state.refreshing) void edit.refresh();
  }, [active, state.status, state.error, state.refreshing, edit]);
  const changes = changedFields(state.base.editable, state.input), keys = Object.keys(changes);
  const editing = state.status === "editing";
  const addressChange = "manualPickupAddress" in changes || "manualDestinationAddress" in changes || "pickup" in changes || "destination" in changes;
  const addressKey = JSON.stringify([state.base.updatedAt, state.input.manualPickupAddress, state.input.manualDestinationAddress, state.input.pickup, state.input.destination]);
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}>
      <Button label="Späť na detail" secondary disabled={state.status === "saving"} onPress={back} /><Text style={styles.heading}>Upraviť {state.base.caseNumber}</Text>
      <Text style={styles.muted}>Zmeny zostanú rozpracované, kým ich neuložíte. Poznámka tu upravuje hlavný text prípadu.</Text>
      {state.receipt && <Card><Text accessibilityRole="alert" style={styles.subheading}>Zmeny sú uložené.</Text>
        {state.receipt.warnings.map((item, i) => <Text key={item.code + i} style={styles.text}>{item.message}</Text>)}
        {state.status === "committed" && <Text style={styles.muted}>Aktuálny detail ešte načítavame. Uloženie sa nebude opakovať.</Text>}</Card>}
      {state.error && <ErrorNotice message={state.error} />}
      {state.status === "uncertain" && <Button label="Overiť pôvodné uloženie" onPress={() => { void edit.save(); }} />}
      {state.status === "committed" && state.error && <Button label="Obnoviť uložený detail" disabled={state.refreshing} onPress={() => { void edit.refresh(); }} secondary />}
      {(state.status === "conflict" || state.status === "blocked" && state.canRecover) && <Card>
        {state.status === "blocked" && <Text style={styles.text}>Pôvodné uloženie bolo zamietnuté. Overte obnovený prístup a porovnajte aktuálne údaje pred ďalším uložením.</Text>}
        <Button label={state.refreshing ? "Načítavam aktuálne údaje…" : "Načítať údaje na porovnanie"} secondary disabled={state.refreshing} onPress={() => { void edit.refresh(); }} />
        {state.latest && <><Text style={styles.subheading}>Porovnanie vašich zmien</Text>
          {keys.map(key => {
            const field = key as keyof typeof state.input;
            const label = fields.find(item => item.key === field)?.label ?? (field === "pickup" ? "Miesto vyzdvihnutia" : field === "destination" ? "Cieľ" : undefined) ?? (field === "priority" ? "Priorita" : field === "jobTypes" ? "Služba" : "Stav prípadu");
            const value = (input: typeof state.input) => field === "pickup" || field === "destination" ? describeSelectedPlace(input[field]) : field === "status" ? state.base.statusOptions.find(option => option.value === input.status)?.label ?? input.status
              : field === "priority" ? priorities.find(option => option.value === input.priority)?.label ?? input.priority
                : field === "jobTypes" ? jobTypes.filter(option => input.jobTypes.includes(option.value)).map(option => option.label).join(", ") : String(input[field] || "Prázdne");
            const locationTarget = field === "pickup" || field === "manualPickupAddress" ? "pickup" : field === "destination" || field === "manualDestinationAddress" ? "destination" : null;
            const current = locationTarget ? describeCurrentPlace(state.latest!, locationTarget) : value(state.latest!.editable);
            return <View key={key}><Text style={styles.label}>{label}</Text><Text style={styles.text}>Moje: {value(state.input)}</Text><Text style={styles.muted}>Aktuálne: {current}</Text></View>;
          })}
          <Text style={styles.muted}>Použitie vašich zmien prepíše iba uvedené polia. Ostatné aktuálne údaje zostanú zachované.</Text>
          <Button label="Použiť moje zmeny na aktuálne údaje" disabled={state.refreshing} onPress={() => edit.rebase()} />
          <Button label="Zahodiť moje zmeny a načítať aktuálne" secondary disabled={state.refreshing} onPress={() => edit.reload()} />
        </>}
      </Card>}
      {fields.map(field => <View key={field.key}><Text style={styles.label}>{field.label}</Text>
        <TextInput accessibilityLabel={field.label} value={field.key === "manualPickupAddress" ? state.input.pickup?.address ?? state.input.manualPickupAddress : field.key === "manualDestinationAddress" ? state.input.destination?.address ?? state.input.manualDestinationAddress : state.input[field.key]} onChangeText={value => edit.edit({ [field.key]: value })} editable={editing}
          maxLength={field.max} multiline={field.multiline} keyboardType={field.key === "contactPhone" ? "phone-pad" : "default"}
          autoCapitalize={field.key === "licensePlate" ? "characters" : "sentences"} autoCorrect={field.key !== "licensePlate" && field.key !== "contactPhone"}
          style={[styles.input, field.multiline && { minHeight: 90, textAlignVertical: "top" }]} />
        {(field.key === "manualPickupAddress" || field.key === "manualDestinationAddress") && <Button label="Vybrať miesto na mape" secondary disabled={!editing}
          onPress={() => setMapTarget(field.key === "manualPickupAddress" ? "pickup" : "destination")} />}
      </View>)}
      <Text style={styles.label}>Služba</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{jobTypes.map(item => <Choice key={item.value} label={item.label}
        selected={state.input.jobTypes.includes(item.value)} disabled={!editing} onPress={() => edit.edit({ jobTypes: state.input.jobTypes.includes(item.value)
          ? state.input.jobTypes.filter(value => value !== item.value) : [...state.input.jobTypes, item.value] })} />)}</View>
      <Text style={styles.label}>Priorita</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{priorities.map(item => <Choice key={item.value} label={item.label}
        selected={state.input.priority === item.value} disabled={!editing} onPress={() => edit.edit({ priority: item.value })} />)}</View>
      <Text style={styles.label}>Stav prípadu</Text><Text style={styles.muted}>Aktuálne: {state.base.statusLabel}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Choice label="Ponechať aktuálny" selected={state.input.status === state.base.editable.status} disabled={!editing} onPress={() => edit.edit({ status: state.base.editable.status })} />
        {state.base.statusOptions.map(item => <Choice key={item.value} label={item.label}
        selected={state.input.status === item.value && state.input.status !== state.base.editable.status} disabled={!editing} onPress={() => edit.edit({ status: item.value })} />)}</View>
      {addressChange && <Card><Text style={styles.text}>Zmena adresy nahradí pôvodné miesto aj jeho uloženú polohu na mape. Prázdna adresa miesto odstráni.</Text>
        <Choice label="Potvrdzujem nahradenie miesta" selected={addressAcknowledged === addressKey} disabled={!editing}
          onPress={() => setAddressAcknowledged(addressAcknowledged === addressKey ? "" : addressKey)} /></Card>}
      {changes.status && ["completed_assisted", "completed_no_assistance", "cancelled", "futile_trip"].includes(changes.status)
        && <Text style={styles.muted}>Prípad zmizne z otvorených prípadov. Nájdete ho cez filter Aj uzavreté.</Text>}
      {active && mapTarget && editing && <CaseMapFrame key={`${state.base.id}:pick:${mapTarget}`} api={api} caseId={state.base.id} mode="pick" target={mapTarget}
        seed={{ selection: state.input[mapTarget] ?? null, address: state.input[mapTarget]?.address ?? state.input[mapTarget === "pickup" ? "manualPickupAddress" : "manualDestinationAddress"] }}
        onClose={() => setMapTarget(null)} onApply={value => edit.selectPlace(mapTarget, value)} />}
      {state.status === "saved" ? <Button label="Zobraziť uložený detail" onPress={back} />
        : <Button label={state.status === "saving" ? "Ukladám zmeny…" : "Uložiť zmeny"} disabled={!editing || keys.length === 0 || addressChange && addressAcknowledged !== addressKey}
          onPress={() => { Keyboard.dismiss(); void edit.save(); }} />}
    </ScrollView>
  </KeyboardAvoidingView>;
}
