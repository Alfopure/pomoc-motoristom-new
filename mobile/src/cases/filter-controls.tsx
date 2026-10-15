import { usePhoneOverlay } from "../ui/phone-overlays";
import { Keyboard, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileCaseFilter } from "../../../src/lib/mobile-api";
import { MOBILE_CASE_STATUSES, MOBILE_CASE_PRIORITIES, caseStatusLabels, casePriorityLabels } from "../../../src/lib/mobile-case-filters";
import { Button, colors, styles } from "../ui";
import { Choice } from "./form";

export function CaseFilterControls({ active, status, priority, onStatus, onPriority }: {
  active: boolean; status: MobileCaseFilter["status"]; priority: MobileCaseFilter["priority"];
  onStatus: (value: MobileCaseFilter["status"]) => void; onPriority: (value: MobileCaseFilter["priority"]) => void;
}) {
  const overlay = usePhoneOverlay<"status" | "priority">(active);
  const picker = overlay.value;
  return <>
    <View style={{ gap: 8 }}>
      <Button secondary label={status ? "Stav: " + caseStatusLabels[status] : "Všetky stavy"} disabled={!overlay.canOpen} onPress={() => { Keyboard.dismiss(); overlay.open("status"); }} />
      <Button secondary label={priority ? "Priorita: " + casePriorityLabels[priority] : "Všetky priority"} disabled={!overlay.canOpen} onPress={() => { Keyboard.dismiss(); overlay.open("priority"); }} />
    </View>
    <Modal visible={active && picker !== null} transparent animationType="fade" onRequestClose={overlay.close}>
      <View style={s.backdrop}><View accessibilityViewIsModal style={s.modal}>
        <Text style={styles.subheading}>{picker === "status" ? "Vybrať stav" : "Vybrať prioritu"}</Text>
        <Button label="Zavrieť filter" secondary onPress={overlay.close} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
          {picker === "status" ? <>
            <Choice label="Bez filtra stavu" selected={!status} onPress={overlay.guard(() => { onStatus(null); overlay.close(); })} />
            {MOBILE_CASE_STATUSES.map(value => <Choice key={value} label={caseStatusLabels[value]} selected={status === value} onPress={overlay.guard(() => { onStatus(value); overlay.close(); })} />)}
          </> : <>
            <Choice label="Bez filtra priority" selected={!priority} onPress={overlay.guard(() => { onPriority(null); overlay.close(); })} />
            {MOBILE_CASE_PRIORITIES.map(value => <Choice key={value} label={casePriorityLabels[value]} selected={priority === value} onPress={overlay.guard(() => { onPriority(value); overlay.close(); })} />)}
          </>}
        </ScrollView>
      </View></View>
    </Modal>
  </>;
}
const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(20,20,28,0.32)", justifyContent: "center", padding: 20 },
  modal: { backgroundColor: colors.white, borderRadius: 28, padding: 22, gap: 16, maxHeight: "85%" },
});
