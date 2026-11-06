import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { TaskChecklistItem, TaskRecurrenceSchedule } from "../../../src/lib/mobile-task-workspace";
import { taskWeekdays } from "./presentation";
import { Button } from "../ui";
import { ChoiceField, Field, FormSection, SelectRow } from "../design/form";
import { palette, space, type } from "../design/tokens";

export function ChecklistEditor({ items, onChange, disabled = false }: {
  items: TaskChecklistItem[]; onChange: (items: TaskChecklistItem[]) => void; disabled?: boolean;
}) {
  const [title, setTitle] = useState("");
  return <>
    <FormSection title="Checklist (voliteľný)" footer="Krátke kroky v jednej úlohe. Riešiteľ aj termín zostávajú spoločné.">
      {items.map((item, index) => <View key={item.id}>
        <Field label={`Bod ${index + 1}`} value={item.title} onChangeText={value => onChange(items.map(row => row.id === item.id ? { ...row, title: value } : row))}
          maxLength={300} editable={!disabled} multiline />
        <SelectRow label={item.done ? "Bod je hotový" : "Označiť bod ako hotový"} selected={item.done} disabled={disabled}
          onPress={() => onChange(items.map(row => row.id === item.id ? { ...row, done: !row.done } : row))} />
        <View style={styles.actions}><Button secondary label={`Odstrániť bod ${index + 1}`} disabled={disabled} onPress={() => onChange(items.filter(row => row.id !== item.id))} /></View>
      </View>)}
      {items.length < 50 ? <Field label="Nový bod" placeholder="Napr. skontrolovať doklady" value={title} onChangeText={setTitle} maxLength={300} editable={!disabled} /> : null}
    </FormSection>
    {items.length < 50 ? <View style={styles.actions}><Button secondary label="Pridať bod" disabled={disabled || !title.trim()} onPress={() => {
      onChange([...items, { id: randomUUID(), title: title.trim(), done: false }]); setTitle("");
    }} /></View> : <Text style={styles.note}>Checklist má maximálne 50 bodov.</Text>}
  </>;
}

/** Only one schedule; the parent persists even a partly typed time as a draft.
 * The transport validates it before any write leaves the device. */
export function RecurrenceEditor({ value, onChange, disabled = false, timeZone, canDisable = true }: {
  value: TaskRecurrenceSchedule | undefined; onChange: (value: TaskRecurrenceSchedule | undefined) => void; disabled?: boolean; timeZone?: string; canDisable?: boolean;
}) {
  const choose = (frequency: "daily" | "weekly" | null) => onChange(frequency ? { frequency, time: value?.time ?? "09:00", ...(frequency === "weekly" ? { weekday: value?.weekday ?? 1 } : {}) } : undefined);
  return <FormSection title="Opakovanie (voliteľné)" footer={value ? `Každý výskyt bude samostatná úloha. Časové pásmo: ${timeZone ?? "podľa organizácie"}.` : "Bežná úloha sa neopakuje."}>
    {canDisable ? <SelectRow label="Neopakovať" selected={!value} disabled={disabled} onPress={() => choose(null)} /> : null}
    <SelectRow label="Denne" selected={value?.frequency === "daily"} disabled={disabled} onPress={() => choose("daily")} />
    <SelectRow label="Týždenne" selected={value?.frequency === "weekly"} disabled={disabled} onPress={() => choose("weekly")} />
    {value ? <Field label="Čas opakovania" placeholder="09:00" value={value.time} onChangeText={time => onChange({ ...value, time })} maxLength={5} keyboardType="numbers-and-punctuation" editable={!disabled} /> : null}
    {value?.frequency === "weekly" ? <ChoiceField label="Deň v týždni">{taskWeekdays.map((day, index) => <View key={day} style={styles.day}>
      <SelectRow label={day} selected={value.weekday === index + 1} disabled={disabled} onPress={() => onChange({ ...value, weekday: index + 1 })} />
    </View>)}</ChoiceField> : null}
  </FormSection>;
}
const styles = StyleSheet.create({
  actions: { paddingHorizontal: space.l, paddingBottom: space.s, gap: space.s },
  note: { ...type.caption, color: palette.secondaryLabel, marginHorizontal: space.l },
  day: { minWidth: "45%", flexGrow: 1 },
});
