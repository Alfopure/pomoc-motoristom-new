import { useState } from "react";
import { Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from "react-native";
import { ArrowLeftRight, ChevronDown, ChevronUp, CircleMinus, CirclePlus } from "lucide-react-native";
import { palette, radius, space, type } from "../design/tokens";
import { GROUPS, PIN_LIMIT, moduleById, type ModuleId } from "./modules";
import { barTabs } from "./navigation";
import { movingPin, pinsFull, replacingPin, withPin, withoutPin } from "./pins";
import { SectionHeader } from "../design/list";
import { AddMark, MiniBar, ModuleTile } from "./parts";

const ROW = 52;
type Props = {
  pins: ModuleId[]; available: ModuleId[]; roleLabel: string; customized: boolean; saveError: boolean;
  onChange: (pins: ModuleId[], message: string) => void; onReset: () => void;
};

export function DoneButton({ onPress }: { onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Hotovo" onPress={onPress} hitSlop={4} style={({ pressed }) => [s.done, pressed && { opacity: 0.8 }]}><Text style={s.doneText}>Hotovo</Text></Pressable>;
}

/** iOS Control Center pattern: – removes, + adds, arrows reorder. Changes apply
 * immediately; a full bar asks which module the new one replaces. */
export function EditBarContent({ pins, available, roleLabel, customized, saveError, onChange, onReset }: Props) {
  const [pick, setPick] = useState<ModuleId | null>(null);
  const others = GROUPS.flatMap(group => available.filter(id => moduleById(id).group === group.id && !pins.includes(id)));
  const pickable = pick && !pins.includes(pick) ? pick : null;
  function add(id: ModuleId) {
    if (pinsFull(pins)) { setPick(id); return; }
    setPick(null); onChange(withPin(pins, id), moduleById(id).name + " je v lište");
  }
  return <>
    <MiniBar tabs={barTabs(pins)} showAdd={pins.length < PIN_LIMIT} style={s.mini} />
    <Text style={[s.note, { textAlign: "center" }]}>Prehľad a Moduly sú v lište vždy. Zmena sa uloží hneď.</Text>
    {saveError && <Text accessibilityRole="alert" style={[s.note, { color: palette.redText, textAlign: "center" }]}>Zmenu sa nepodarilo uložiť v telefóne. Platí, kým appku nezatvoríte.</Text>}
    {pickable && <View style={s.pickBar}><ArrowLeftRight size={16} color="#3D3000" accessible={false} />
      <Text style={s.pickText}>Lišta je plná. Ťuknite na modul, ktorý nahradí <Text style={{ fontWeight: "700" }}>{moduleById(pickable).name}</Text>.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Zrušiť výber" onPress={() => setPick(null)} hitSlop={13}><Text style={s.pickCancel}>Zrušiť</Text></Pressable>
    </View>}
    <SectionHeader title="V lište" detail={pins.length + " z " + PIN_LIMIT + (pins.length > 1 && !pickable ? " · poradie menia šípky" : "")} />
    <View style={s.group}>
      {pins.map((id, index) => pickable
        ? <Pressable key={id} accessibilityRole="button" accessibilityLabel={"Nahradiť " + moduleById(id).name} onPress={() => {
          onChange(replacingPin(pins, id, pickable), moduleById(pickable).name + " namiesto " + moduleById(id).name); setPick(null);
        }} style={({ pressed }) => [s.row, s.pickRow, index > 0 && s.rowBorder, pressed && { opacity: 0.8 }]}>
          <ModuleTile id={id} /><Text numberOfLines={1} style={s.rowTitle}>{moduleById(id).name}</Text><View style={s.replace}><Text style={s.replaceText}>Nahradiť</Text></View>
        </Pressable>
        : <PinRow key={id} id={id} index={index} count={pins.length} onRemove={() => onChange(withoutPin(pins, id), moduleById(id).name + " odobraté z lišty")}
          onMove={to => onChange(movingPin(pins, index, to), "Poradie lišty je zmenené")} />)}
      {Array.from({ length: PIN_LIMIT - pins.length }, (_, index) => <View key={"empty" + index} style={[s.row, (pins.length + index) > 0 && s.rowBorder]}>
        <AddMark size={22} /><Text style={s.empty}>Voľné miesto – pridajte modul nižšie</Text></View>)}
    </View>
    {others.length > 0 && <>
      <SectionHeader title="Ďalšie moduly" detail="ťuknutím pridáte do lišty" />
      <View style={s.group}>{others.map((id, index) => <Pressable key={id} accessibilityRole="button" accessibilityLabel={"Pridať " + moduleById(id).name + " do lišty"}
        onPress={() => add(id)} style={({ pressed }) => [s.row, index > 0 && s.rowBorder, pickable === id && s.pickRow, pressed && { backgroundColor: "#ECECF0" }]}>
        <CirclePlus size={22} color="#FFFFFF" fill={palette.green} accessible={false} /><ModuleTile id={id} />
        <Text numberOfLines={1} style={s.rowTitle}>{moduleById(id).name}</Text>
      </Pressable>)}</View>
    </>}
    <View style={[s.group, { marginTop: space.l }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !customized }} disabled={!customized} onPress={() => { setPick(null); onReset(); }}
        style={({ pressed }) => [s.row, pressed && { backgroundColor: "#ECECF0" }]}>
        <Text style={[s.rowTitle, { color: customized ? palette.brandInk : palette.tertiaryLabel }]}>Obnoviť predvolené pre rolu {roleLabel}</Text>
      </Pressable>
    </View>
    <Text style={s.note}>Ako v Ovládacom centre iPhonu: – odoberie, + pridá, šípky menia poradie.</Text>
  </>;
}

/** Visible arrows reorder the bar; VoiceOver gets the same actions on the row. */
function PinRow({ id, index, count, onRemove, onMove }: { id: ModuleId; index: number; count: number; onRemove: () => void; onMove: (to: number) => void }) {
  const name = moduleById(id).name;
  const first = index === 0, last = index === count - 1;
  const actions = [{ name: "remove", label: "Odobrať z lišty" }, ...(!first ? [{ name: "moveUp", label: "Posunúť vyššie" }] : []), ...(!last ? [{ name: "moveDown", label: "Posunúť nižšie" }] : [])];
  function action(event: AccessibilityActionEvent) {
    if (event.nativeEvent.actionName === "remove") onRemove();
    if (event.nativeEvent.actionName === "moveUp" && !first) onMove(index - 1);
    if (event.nativeEvent.actionName === "moveDown" && !last) onMove(index + 1);
  }
  return <View accessible accessibilityLabel={name + ", " + (index + 1) + ". v lište"} accessibilityActions={actions} onAccessibilityAction={action}
    style={[s.row, index > 0 && s.rowBorder]}>
    <Pressable accessibilityRole="button" accessibilityLabel={"Odobrať " + name + " z lišty"} onPress={onRemove} hitSlop={11}>
      <CircleMinus size={22} color="#FFFFFF" fill={palette.red} accessible={false} /></Pressable>
    <ModuleTile id={id} /><Text numberOfLines={1} style={s.rowTitle}>{name}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={"Posunúť " + name + " vyššie"} accessibilityState={{ disabled: first }} disabled={first}
      onPress={() => onMove(index - 1)} style={({ pressed }) => [s.move, first && s.moveOff, pressed && { opacity: 0.6 }]}>
      <ChevronUp size={18} strokeWidth={2.4} color={first ? palette.tertiaryLabel : palette.label} accessible={false} /></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={"Posunúť " + name + " nižšie"} accessibilityState={{ disabled: last }} disabled={last}
      onPress={() => onMove(index + 1)} style={({ pressed }) => [s.move, last && s.moveOff, pressed && { opacity: 0.6 }]}>
      <ChevronDown size={18} strokeWidth={2.4} color={last ? palette.tertiaryLabel : palette.label} accessible={false} /></Pressable>
  </View>;
}
const s = StyleSheet.create({
  mini: { marginHorizontal: space.l, marginTop: space.s, backgroundColor: palette.card },
  note: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 22, paddingTop: space.s },
  done: { minHeight: 36, borderRadius: 18, backgroundColor: palette.brand, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  doneText: { ...type.rowTitle, color: palette.label },
  pickBar: { flexDirection: "row", alignItems: "center", gap: space.s, marginHorizontal: space.l, marginTop: space.m, padding: space.m, borderRadius: 14, backgroundColor: palette.brandSoft },
  pickText: { ...type.subhead, color: "#3D3000", flex: 1 },
  pickCancel: { ...type.rowTitle, fontSize: 14, color: palette.brandInk },
  group: { marginHorizontal: space.l, backgroundColor: palette.card, borderRadius: radius.l, overflow: "hidden" },
  row: { minHeight: ROW, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: space.m, backgroundColor: palette.card },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator },
  rowTitle: { ...type.rowTitle, color: palette.label, flex: 1 },
  move: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  moveOff: { opacity: 0.5 },
  empty: { ...type.subhead, color: palette.tertiaryLabel, flex: 1 },
  pickRow: { backgroundColor: "#FFFCEB" },
  replace: { borderRadius: 13, backgroundColor: "#1C1C1E", paddingHorizontal: 11, paddingVertical: 5 },
  replaceText: { fontSize: 13, lineHeight: 16, fontWeight: "700", color: "#FFFFFF" },
});
