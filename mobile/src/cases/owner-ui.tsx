import { useEffect, useRef, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { CaseOwnerDraft } from "./owner";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import { FormSection, FormText, SelectRow, formLayout } from "../design/form";
import { useAndroidBack } from "../lib/use-android-back";
import { useShellBack } from "../shell/back";
export function CaseOwnerForm({ draft, active, onBack, onSaved }: { draft: CaseOwnerDraft; active: boolean; onBack: () => void; onSaved: () => void }) {
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot), scroll = useRef<ScrollView>(null);
  const back = () => { if (draft.snapshot().status !== "saving") onBack(); };
  useAndroidBack(active, back, state.status === "saving");
  useShellBack(active, "Prípad", back, state.status === "saving");
  useEffect(() => { draft.setActive(active); if (active) void draft.refresh(); return () => draft.setActive(false); }, [active, draft]);
  useEffect(() => { if (state.status === "saved") { onSaved(); if (active) void draft.refresh(); } }, [active, state.status, onSaved, draft]);
  useEffect(() => { if (active && (state.error || state.status === "saved")) scroll.current?.scrollTo({ y: 0, animated: false }); }, [active, state.error, state.status]);
  const context = state.context, editable = state.status === "editing" && !state.refreshing;
  const selected = context?.targets.find(item => item.id === state.selectedId);
  const conflict = (state.status === "conflict" || state.status === "blocked" && state.canRecover) && context;
  return <ScrollView ref={scroll} contentContainerStyle={formLayout.content}>
    <View style={formLayout.head}><Text accessibilityRole="header" style={styles.heading}>Dispečer prípadu</Text></View>
    <View style={formLayout.notices}>
      {state.receipt && <Card><Text accessibilityRole="alert" style={styles.subheading}>Priradenie je uložené.</Text><Text style={styles.muted}>Obnova detailu neopakuje priradenie.</Text></Card>}
      {state.error && <ErrorNotice message={state.error} />}
      {state.status === "uncertain" && <Button label="Overiť pôvodné priradenie" onPress={() => { void draft.reconcile(); }} />}
      {state.refreshing ? <Loading /> : <Button label="Obnoviť priradenie" secondary disabled={state.status === "saving"} onPress={() => { void draft.refresh(); }} />}
    </View>
    {context && <FormSection title="Aktuálny dispečer" footer={!context.available ? "Priradenie zatiaľ nie je na serveri dostupné."
      : !context.capabilities.assign && !context.capabilities.take ? "Tento prípad teraz nemožno priradiť." : null}>
      <FormText>{context.owner.name || "Nepriradené"}</FormText>
    </FormSection>}
    {context && editable && context.capabilities.take && <View style={formLayout.notices}><Button label="Prevziať prípad" secondary onPress={() => draft.select(context.profileId)} /></View>}
    {context && editable && context.capabilities.assign && <FormSection title="Priradiť kolegovi">
      {context.targets.map(target => <SelectRow key={target.id} label={target.name} selected={state.selectedId === target.id} onPress={() => draft.select(target.id)} />)}
    </FormSection>}
    {(conflict || editable && selected || state.status === "saving" || state.status === "saved") && <View style={formLayout.actions}>
      {conflict && <Card><Text style={styles.text}>Pôvodne: {state.baseline?.owner.name || "Nepriradené"}</Text>
        <Text style={styles.text}>Aktuálne: {context.owner.name || "Nepriradené"}</Text><Button label="Porovnal som údaje – pokračovať výberom" onPress={() => draft.review()} />
        {state.status === "conflict" && <Button label="Zahodiť výber dispečera" secondary onPress={() => draft.reset()} />}</Card>}
      {editable && selected && <Card><Text style={styles.text}>{context?.owner.name || "Nepriradené"} → {selected.name}</Text>
        <Text style={styles.muted}>Zmení sa iba dispečer prípadu. Súvisiace úlohy sa nepresúvajú.</Text><Button primary label="Potvrdiť priradenie" onPress={() => { void draft.submit(); }} /></Card>}
      {state.status === "saving" && <Text accessibilityRole="alert" style={styles.text}>Ukladám priradenie…</Text>}
      {state.status === "saved" && <Button label="Pripraviť ďalšie priradenie" secondary onPress={() => { draft.reset(); void draft.refresh(); }} />}
    </View>}
  </ScrollView>;
}
