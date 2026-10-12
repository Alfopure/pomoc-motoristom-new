import { useState } from "react";
import { Keyboard, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileCaseFilter } from "../../../src/lib/mobile-api";
import { MOBILE_CASE_STATUSES, MOBILE_CASE_PRIORITIES, caseStatusLabels, casePriorityLabels } from "../../../src/lib/mobile-case-filters";
import { Button, colors, styles } from "../ui";
import { Choice } from "./form";

export function CaseFilterControls({ active, status, priority, onStatus, onPriority }: {
  active: boolean; status: MobileCaseFilter["status"]; priority: MobileCaseFilter["priority"];
  onStatus: (value: MobileCaseFilter["status"]) => void; onPriority: (value: MobileCaseFilter["priority"]) => void;
}) {
  const [picker, setPicker] = useState<"status" | "priority" | null>(null);
  return <>
    <View style={{ gap: 8 }}>
      <Button secondary label={status ? "Stav: " + caseStatusLabels[status] : "Všetky stavy"} onPress={() => { Keyboard.dismiss(); setPicker("status"); }} />
      <Button secondary label={priority ? "Priorita: " + casePriorityLabels[priority] : "Všetky priority"} onPress={() => { Keyboard.dismiss(); setPicker("priority"); }} />
    </View>
    <Modal visible={active && picker !== null} transparent animationType="fade" onRequestClose={() => setPicker(null)}>
      <View style={s.backdrop}><View accessibilityViewIsModal style={s.modal}>
        <Text style={styles.subheading}>{picker === "status" ? "Vybrať stav" : "Vybrať prioritu"}</Text>
        <Button label="Zavrieť filter" secondary onPress={() => setPicker(null)} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
          {picker === "status" ? <>
            <Choice label="Bez filtra stavu" selected={!status} onPress={() => { onStatus(null); setPicker(null); }} />
            {MOBILE_CASE_STATUSES.map(value => <Choice key={value} label={caseStatusLabels[value]} selected={status === value} onPress={() => { onStatus(value); setPicker(null); }} />)}
          </> : <>
            <Choice label="Bez filtra priority" selected={!priority} onPress={() => { onPriority(null); setPicker(null); }} />
            {MOBILE_CASE_PRIORITIES.map(value => <Choice key={value} label={casePriorityLabels[value]} selected={priority === value} onPress={() => { onPriority(value); setPicker(null); }} />)}
          </>}
        </ScrollView>
      </View></View>
    </Modal>
  </>;
}
const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 20 },
  modal: { backgroundColor: colors.white, borderRadius: 20, padding: 20, gap: 14, maxHeight: "85%" },
});
