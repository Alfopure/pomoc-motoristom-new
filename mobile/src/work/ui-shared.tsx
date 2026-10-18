import { usePhoneOverlay } from "../ui/phone-overlays";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { WorkApi } from "./api";
import { Button, ErrorNotice, Loading, colors, styles } from "../ui";
import type { MobileTask } from "../../../src/lib/mobile-api";
import { Choice, priorities } from "../cases/form";
import { formatTime } from "../lib/display";
import { MobileApiError } from "../lib/api";
import { PickerRow } from "../design/form";
export const workError = (error: unknown) => error instanceof MobileApiError ? error.message : error instanceof Error ? error.message : "Údaje sa nepodarilo načítať.";
export const workflowLabels = { todo: "Na vybavenie", in_progress: "Rozpracované", in_review: "Na kontrolu", done: "Vybavené" };
export const taskKinds = [{ value: "callback", label: "Zavolať" }, { value: "sms", label: "SMS" }, { value: "dispatch", label: "Dispečing" }, { value: "documents", label: "Dokumenty" }, { value: "billing", label: "Fakturácia" }, { value: "handover", label: "Odovzdanie" }, { value: "other", label: "Iné" }] as const;
/** `row` shows it as a form row (label above the chosen name) instead of a button. */
export function ColleaguePicker({ api, queryKey, active, label, value, onChange, disabled, row }: { api: WorkApi; queryKey: string[]; active: boolean; label: string; value: string | null; onChange: (id: string | null) => void; disabled?: boolean; row?: boolean }) {
  const overlay = usePhoneOverlay<boolean>(active);
  const open = overlay.value === true;
  const query = useQuery({ queryKey: [...queryKey, "colleagues"], queryFn: ({ signal }) => api.colleagues(signal), enabled: active && (open || !!value) });
  const name = query.isError ? "Vybraný kolega" : query.data?.colleagues.find(v => v.id === value)?.name ?? "Vybraný kolega";
  return <>{row ? <PickerRow label={label} value={value ? name : "Bez výberu"} disabled={disabled || !overlay.canOpen} onPress={() => overlay.open(true)} />
    : <Button label={label + ": " + (value ? name : "Bez výberu")} secondary disabled={disabled || !overlay.canOpen} onPress={() => overlay.open(true)} />}
    <Modal visible={active && open} transparent animationType="fade" onRequestClose={overlay.close}><View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", padding: 20, justifyContent: "center" }}>
      <View accessibilityViewIsModal style={{ backgroundColor: colors.white, borderRadius: 20, padding: 20, gap: 15, maxHeight: "80%" }}>
        <Text style={styles.subheading}>{label}</Text><Button label="Zavrieť výber" secondary onPress={overlay.close} />
        <ScrollView contentContainerStyle={{ gap: 10 }}><Choice label="Bez výberu" selected={!value} onPress={overlay.guard(() => { onChange(null); overlay.close(); })} />
          {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={workError(query.error)} onRetry={() => { void query.refetch(); }} /> : query.data?.colleagues.map(item =>
            <Choice key={item.id} label={item.name} selected={value === item.id} onPress={overlay.guard(() => { onChange(item.id); overlay.close(); })} />)}</ScrollView>
      </View></View></Modal></>;
}

/** Compact task rows: title and due time, state and priority, who works on it. */
export function TaskRows({ items, onOpen }: { items: MobileTask[]; onOpen: (id: string) => void }) {
  return <View style={rowStyles.group}>{items.map((item, index) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={"Otvoriť úlohu " + item.title} onPress={() => onOpen(item.id)}
    style={({ pressed }) => [rowStyles.row, pressed && { backgroundColor: "#ECECF0" }]}>
    {index > 0 && <View style={rowStyles.separator} />}
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <View style={rowStyles.titleLine}><Text numberOfLines={1} style={rowStyles.title}>{item.title}</Text>{item.dueAt ? <Text style={rowStyles.due}>{formatTime(item.dueAt)}</Text> : null}</View>
      <Text numberOfLines={1} style={styles.muted}>{workflowLabels[item.workflowState]} · {priorities.find(value => value.value === item.priority)?.label}</Text>
      <Text numberOfLines={1} style={rowStyles.meta}>{[item.assignedTo?.name ?? "Nepriradená", item.reviewer ? "Kontrolór: " + item.reviewer.name : null].filter(Boolean).join(" · ")}</Text>
    </View>
    <Text style={rowStyles.chevron}>›</Text>
  </Pressable>)}</View>;
}
const rowStyles = StyleSheet.create({
  group: { backgroundColor: colors.white, borderRadius: 16, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 8, minHeight: 60 },
  separator: { position: "absolute", top: 0, left: 12, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: "rgba(60,60,67,0.16)" },
  titleLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "600", color: colors.ink, flex: 1 },
  due: { fontSize: 12, lineHeight: 16, fontWeight: "500", color: colors.muted, fontVariant: ["tabular-nums"] },
  meta: { fontSize: 12, lineHeight: 16, color: colors.muted },
  chevron: { fontSize: 20, color: "#AEAEB2" },
});
