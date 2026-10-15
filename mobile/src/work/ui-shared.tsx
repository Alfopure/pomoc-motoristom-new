import { usePhoneOverlay } from "../ui/phone-overlays";
import { Modal, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { WorkApi } from "./api";
import { Button, ErrorNotice, Loading, colors, styles } from "../ui";
import { Choice } from "../cases/form";
import { MobileApiError } from "../lib/api";
export const workError = (error: unknown) => error instanceof MobileApiError ? error.message : error instanceof Error ? error.message : "Údaje sa nepodarilo načítať.";
export const workflowLabels = { todo: "Na vybavenie", in_progress: "Rozpracované", in_review: "Na kontrolu", done: "Vybavené" };
export const taskKinds = [{ value: "callback", label: "Zavolať" }, { value: "sms", label: "SMS" }, { value: "dispatch", label: "Dispečing" }, { value: "documents", label: "Dokumenty" }, { value: "billing", label: "Fakturácia" }, { value: "handover", label: "Odovzdanie" }, { value: "other", label: "Iné" }] as const;
export function ColleaguePicker({ api, queryKey, active, label, value, onChange, disabled }: { api: WorkApi; queryKey: string[]; active: boolean; label: string; value: string | null; onChange: (id: string | null) => void; disabled?: boolean }) {
  const overlay = usePhoneOverlay<boolean>(active);
  const open = overlay.value === true;
  const query = useQuery({ queryKey: [...queryKey, "colleagues"], queryFn: ({ signal }) => api.colleagues(signal), enabled: active && (open || !!value) });
  const name = query.isError ? "Vybraný kolega" : query.data?.colleagues.find(v => v.id === value)?.name ?? "Vybraný kolega";
  return <><Button label={label + ": " + (value ? name : "Bez výberu")} secondary disabled={disabled || !overlay.canOpen} onPress={() => overlay.open(true)} />
    <Modal visible={active && open} transparent animationType="fade" onRequestClose={overlay.close}><View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", padding: 20, justifyContent: "center" }}>
      <View accessibilityViewIsModal style={{ backgroundColor: colors.white, borderRadius: 20, padding: 20, gap: 15, maxHeight: "80%" }}>
        <Text style={styles.subheading}>{label}</Text><Button label="Zavrieť výber" secondary onPress={overlay.close} />
        <ScrollView contentContainerStyle={{ gap: 10 }}><Choice label="Bez výberu" selected={!value} onPress={overlay.guard(() => { onChange(null); overlay.close(); })} />
          {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={workError(query.error)} onRetry={() => { void query.refetch(); }} /> : query.data?.colleagues.map(item =>
            <Choice key={item.id} label={item.name} selected={value === item.id} onPress={overlay.guard(() => { onChange(item.id); overlay.close(); })} />)}</ScrollView>
      </View></View></Modal></>;
}
