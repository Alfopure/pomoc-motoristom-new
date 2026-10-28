import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { formLayout } from "../design/form";
import { palette, space, type } from "../design/tokens";
import { Button, ErrorNotice, styles } from "../ui";
import type { PendingWork, WorkCommands, WorkCommandsView } from "./commands";

/** Shared pieces of Moja práca and Pobočka, built from the standard tokens. */
/** `onCard`: inside a white form group, where an unselected chip is gray. */
export function Chip({ label, selected, onPress, disabled, accessibilityLabel, onCard }: { label: string; selected: boolean; onPress: () => void; disabled?: boolean; accessibilityLabel?: string; onCard?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected, disabled: Boolean(disabled) }} disabled={disabled}
    hitSlop={{ top: 4, bottom: 4 }} onPress={onPress} style={({ pressed }) => [s.chip, onCard && { backgroundColor: palette.fill }, selected && s.chipSelected, disabled && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}>
    <Text numberOfLines={1} style={[s.chipText, selected && { color: palette.card }]}>{label}</Text>
  </Pressable>;
}

export function StorageNotice({ commands, state }: { commands: WorkCommands; state: WorkCommandsView }) {
  if (state.ready && !state.error && Platform.OS !== "web") return null;
  return <View style={formLayout.notices}>
    {!state.ready && !state.error && <Text style={styles.muted}>Overujem uložené kroky…</Text>}
    {state.error && <ErrorNotice message={state.error} onRetry={!state.ready ? () => { void commands.load(); } : undefined} />}
    {Platform.OS === "web" && <Text style={styles.muted}>V prehliadači zostávajú nepotvrdené kroky iba do zatvorenia stránky. Na prácu v teréne použite aplikáciu v telefóne.</Text>}
  </View>;
}

/** An unconfirmed step: retry the same command, or after a refusal read the current state and close it. */
export function StepRecovery({ commands, record, busy, onResult, onReload }: {
  commands: WorkCommands; record: PendingWork; busy: boolean; onResult: (result: unknown) => void; onReload: () => Promise<unknown>;
}) {
  return <View style={formLayout.notices}>
    <Text style={styles.label}>{"Krok: " + record.label}</Text>
    <Text style={styles.muted}>{record.status === "sending" ? "Čakám na potvrdenie servera…"
      : record.status === "confirmed" ? record.message
        : record.status === "rejected" ? "Server krok odmietol. Načítajte aktuálny stav a skontrolujte ho pred ďalším krokom."
          : "Potvrdenie kroku neprišlo. Krok už mohol byť uložený. Overte ho týmto tlačidlom; ďalší krok bude dostupný po vyriešení výsledku."}</Text>
    {record.message && record.status !== "confirmed" && <Text style={styles.muted}>{record.message}</Text>}
    {record.status !== "rejected" && <Button label={busy ? "Overujem…" : "Overiť rovnaký krok"} disabled={busy} onPress={() => {
      void commands.retry(record.target).then(result => { if (result) onResult(result); });
    }} />}
    {record.status === "rejected" && <Button secondary label="Načítať aktuálny stav a uzavrieť krok" disabled={busy} onPress={() => {
      void onReload().then(() => commands.dismiss(record.target));
    }} />}
  </View>;
}

export const fieldStyles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.s, paddingHorizontal: space.l, paddingTop: space.s },
  empty: { ...type.subhead, color: palette.secondaryLabel, paddingHorizontal: 20 },
  note: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 20, paddingTop: space.m },
  row: { flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.m, paddingVertical: 10, minHeight: 64, backgroundColor: palette.card },
  separator: { position: "absolute", top: 0, left: 60, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { ...type.rowTitle, color: palette.label, flexShrink: 1 },
  rowDetail: { ...type.subhead, color: palette.secondaryLabel },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
});
const s = StyleSheet.create({
  chip: { minHeight: 36, borderRadius: 18, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", backgroundColor: palette.card },
  chipSelected: { backgroundColor: palette.label },
  chipText: { ...type.rowTitle, color: palette.label },
});
