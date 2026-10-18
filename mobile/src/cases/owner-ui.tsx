import { useEffect, useRef, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { CaseOwnerDraft } from "./owner";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import { Choice } from "./form";
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
  return <ScrollView ref={scroll} contentContainerStyle={styles.content}>
    <Text accessibilityRole="header" style={styles.heading}>Dispečer prípadu</Text>
    {state.receipt && <Card><Text accessibilityRole="alert" style={styles.subheading}>Priradenie je uložené.</Text><Text style={styles.muted}>Obnova detailu neopakuje priradenie.</Text></Card>}
    {state.error && <ErrorNotice message={state.error} />}
    {state.status === "uncertain" && <Button label="Overiť pôvodné priradenie" onPress={() => { void draft.reconcile(); }} />}
    {state.refreshing ? <Loading /> : <Button label="Obnoviť priradenie" secondary disabled={state.status === "saving"} onPress={() => { void draft.refresh(); }} />}
    {context && <Card><Text style={styles.label}>Aktuálny dispečer</Text><Text style={styles.text}>{context.owner.name || "Nepriradené"}</Text>
      {!context.available && <Text style={styles.muted}>Priradenie zatiaľ nie je na serveri dostupné.</Text>}
      {context.available && !context.capabilities.assign && !context.capabilities.take && <Text style={styles.muted}>Tento prípad teraz nemožno priradiť.</Text>}
      {editable && context.capabilities.take && <Button label="Prevziať prípad" secondary onPress={() => draft.select(context.profileId)} />}
      {editable && context.capabilities.assign && <View style={{ gap: 8 }}>{context.targets.map(target => <Choice key={target.id} label={target.name} selected={state.selectedId === target.id} onPress={() => draft.select(target.id)} />)}</View>}
    </Card>}
    {(state.status === "conflict" || state.status === "blocked" && state.canRecover) && context && <Card><Text style={styles.text}>Pôvodne: {state.baseline?.owner.name || "Nepriradené"}</Text>
      <Text style={styles.text}>Aktuálne: {context.owner.name || "Nepriradené"}</Text><Button label="Porovnal som údaje – pokračovať výberom" onPress={() => draft.review()} />
      {state.status === "conflict" && <Button label="Zahodiť výber dispečera" secondary onPress={() => draft.reset()} />}</Card>}
    {editable && selected && <Card><Text style={styles.text}>{context?.owner.name || "Nepriradené"} → {selected.name}</Text>
      <Text style={styles.muted}>Zmení sa iba dispečer prípadu. Súvisiace úlohy sa nepresúvajú.</Text><Button label="Potvrdiť priradenie" onPress={() => { void draft.submit(); }} /></Card>}
    {state.status === "saving" && <Text accessibilityRole="alert" style={styles.text}>Ukladám priradenie…</Text>}
    {state.status === "saved" && <Button label="Pripraviť ďalšie priradenie" secondary onPress={() => { draft.reset(); void draft.refresh(); }} />}
  </ScrollView>;
}
