import { Pressable, StyleSheet, Text } from "react-native";
import { ChevronDown } from "lucide-react-native";
import type { MobileCaseCreateInput, MobileCaseJobType, MobileCasePriority } from "../../../src/lib/mobile-api";
import { colors } from "../ui";

export const priorities: { value: MobileCasePriority; label: string }[] = [
  { value: "urgent", label: "Horí" }, { value: "high", label: "Vysoká" }, { value: "normal", label: "Bežná" }, { value: "low", label: "Nízka" },
];
export const jobTypes: { value: MobileCaseJobType; label: string }[] = [
  { value: "tow", label: "Odťah" }, { value: "replacement_vehicle", label: "Náhradné vozidlo" },
  { value: "onsite_assistance", label: "Asistencia na mieste" }, { value: "vehicle_recovery", label: "Vyslobodenie MV" },
];
export type CaseFieldKey = keyof Pick<MobileCaseCreateInput, "contactName" | "contactPhone" | "licensePlate" | "vehicleMake" | "vehicleModel" | "manualPickupAddress" | "manualDestinationAddress" | "incidentDescription" | "note">;
export const fields: { key: CaseFieldKey; label: string; max: number; multiline?: boolean; section: "Kontakt" | "Vozidlo" | "Miesto" | "Problém"; placeholder: string }[] = [
  { key: "contactName", label: "Meno kontaktu", max: 200, section: "Kontakt", placeholder: "Meno a priezvisko" },
  { key: "contactPhone", label: "Telefón kontaktu", max: 64, section: "Kontakt", placeholder: "+421 …" },
  { key: "licensePlate", label: "EČV", max: 32, section: "Vozidlo", placeholder: "napr. BA123AB" },
  { key: "vehicleMake", label: "Značka vozidla", max: 80, section: "Vozidlo", placeholder: "napr. Škoda" },
  { key: "vehicleModel", label: "Model vozidla", max: 120, section: "Vozidlo", placeholder: "napr. Octavia" },
  { key: "manualPickupAddress", label: "Miesto vyzdvihnutia", max: 500, multiline: true, section: "Miesto", placeholder: "Adresa alebo opis miesta" },
  { key: "manualDestinationAddress", label: "Cieľová adresa", max: 500, multiline: true, section: "Miesto", placeholder: "Kam vozidlo odviezť" },
  { key: "incidentDescription", label: "Popis problému", max: 5000, multiline: true, section: "Problém", placeholder: "Čo sa stalo" },
  { key: "note", label: "Poznámka", max: 10000, multiline: true, section: "Problém", placeholder: "Doplňujúce informácie" },
];
export function Choice({ label, selected, onPress, disabled }: { label: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled: Boolean(disabled) }} onPress={onPress} disabled={disabled} hitSlop={{ top: 4, bottom: 4 }}
    style={({ pressed }) => [formStyles.choice, selected && formStyles.selected, disabled && { opacity: 0.6 }, pressed && !selected && { opacity: 0.7 }]}>
    <Text style={[formStyles.label, selected && { color: colors.white }]}>{label}</Text>
  </Pressable>;
}
/** Opens a picker; filled when a value is chosen, so active filters stand out. */
export function MenuChip({ label, active, onPress, disabled }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} onPress={onPress} disabled={disabled} hitSlop={{ top: 4, bottom: 4 }}
    style={({ pressed }) => [formStyles.choice, formStyles.menu, active && formStyles.selected, disabled && { opacity: 0.6 }, pressed && { opacity: 0.7 }]}>
    <Text numberOfLines={1} style={[formStyles.label, { flexShrink: 1 }, active && { color: colors.white }]}>{label}</Text>
    <ChevronDown size={15} strokeWidth={2.4} color={active ? colors.white : colors.ink} accessible={false} />
  </Pressable>;
}
const formStyles = StyleSheet.create({
  menu: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" },
  choice: { borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: "center", backgroundColor: colors.white, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(60,60,67,0.22)" },
  label: { fontSize: 14, lineHeight: 18, fontWeight: "600", color: colors.ink },
  selected: { backgroundColor: colors.ink, borderColor: colors.ink },
});
