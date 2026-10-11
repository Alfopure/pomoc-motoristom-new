import { Pressable, StyleSheet, Text } from "react-native";
import type { MobileCaseCreateInput, MobileCaseJobType, MobileCasePriority } from "../../../src/lib/mobile-api";
import { colors, styles } from "../ui";

export const priorities: { value: MobileCasePriority; label: string }[] = [
  { value: "urgent", label: "Horí" }, { value: "high", label: "Vysoká" }, { value: "normal", label: "Bežná" }, { value: "low", label: "Nízka" },
];
export const jobTypes: { value: MobileCaseJobType; label: string }[] = [
  { value: "tow", label: "Odťah" }, { value: "replacement_vehicle", label: "Náhradné vozidlo" },
  { value: "onsite_assistance", label: "Asistencia na mieste" }, { value: "vehicle_recovery", label: "Vyslobodenie MV" },
];
export const fields: { key: keyof Pick<MobileCaseCreateInput, "contactName" | "contactPhone" | "licensePlate" | "vehicleMake" | "vehicleModel" | "manualPickupAddress" | "manualDestinationAddress" | "incidentDescription" | "note">; label: string; max: number; multiline?: boolean }[] = [
  { key: "contactName", label: "Meno kontaktu", max: 200 }, { key: "contactPhone", label: "Telefón kontaktu", max: 64 },
  { key: "licensePlate", label: "EČV", max: 32 }, { key: "vehicleMake", label: "Značka vozidla", max: 80 }, { key: "vehicleModel", label: "Model vozidla", max: 120 },
  { key: "manualPickupAddress", label: "Miesto vyzdvihnutia", max: 500, multiline: true }, { key: "manualDestinationAddress", label: "Cieľová adresa", max: 500, multiline: true },
  { key: "incidentDescription", label: "Popis problému", max: 5000, multiline: true }, { key: "note", label: "Poznámka", max: 10000, multiline: true },
];
export function Choice({ label, selected, onPress, disabled }: { label: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled: Boolean(disabled) }} onPress={onPress} disabled={disabled}
    style={[formStyles.choice, selected && formStyles.selected, disabled && { opacity: 0.6 }]}>
    <Text style={[styles.muted, selected && { color: colors.white }]}>{label}</Text>
  </Pressable>;
}
const formStyles = StyleSheet.create({
  choice: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, minHeight: 44, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  selected: { backgroundColor: colors.ink, borderColor: colors.ink },
});
