import { useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, FilePlus2, Grid3x3, Info, Mic, MicOff, Pause, Phone, PhoneOff, Play, Volume2 } from "lucide-react-native";
import { palette, space, type } from "../design/tokens";
import { ErrorNotice } from "../ui";
import { formatNumber } from "../lib/display";
import { elapsed } from "../shell/call-bar-model";
import type { DispatchPhone, PhoneState } from "../voice/phone";
import type { CallView } from "./call-screen-model";

/** Server facts about the phone's own call: the line the customer called and the start time. */
export type CallFacts = { lineLabel: string | null; name: string | null; startedAt: string | null };
type Common = { view: CallView; facts: CallFacts | null; connectedAt: number | null };

function useClock(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(Date.now()), first = setTimeout(tick, 0), timer = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [running]);
  return now;
}
function duration({ view, facts, connectedAt }: Common, now: number) {
  if (!view.connected) return "";
  const start = facts?.startedAt ? Date.parse(facts.startedAt) : connectedAt;
  return start && Number.isFinite(start) ? elapsed(new Date(start).toISOString(), now) : "";
}
const toneColor = { ringing: palette.redText, active: palette.greenText, held: palette.orangeText, working: "#3A3A3C" } as const;

/** Above the app while the call screen is hidden; one tap brings the controls back. */
export function CallStrip(props: Common & { onExpand: () => void }) {
  const now = useClock(props.view.connected);
  const time = duration(props, now);
  const title = props.facts?.name || props.view.title;
  return <Pressable accessibilityRole="button" accessibilityLabel={"Hovor: " + title + ", " + props.view.status + (time ? ", " + time : "") + ". Otvoriť ovládanie hovoru"}
    onPress={props.onExpand} style={({ pressed }) => [s.strip, { backgroundColor: toneColor[props.view.tone] }, pressed && { opacity: 0.85 }]}>
    <Phone size={15} strokeWidth={2.6} color="#FFFFFF" accessible={false} />
    <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.stripTitle}>{title}</Text>
    <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.stripStatus}>{time ? props.view.status + " · " + time : props.view.status}</Text>
  </Pressable>;
}

/** Full-screen controls of the phone's own call. Every action keeps a visible label. */
export function CallScreen(props: Common & {
  visible: boolean; phone: DispatchPhone; state: PhoneState; onMinimize: () => void;
  onDetail: (() => void) | null; onNewCase: (() => void) | null;
}) {
  const { view, phone, state } = props;
  const insets = useSafeAreaInsets();
  const [keypad, setKeypad] = useState(false);
  const [digits, setDigits] = useState("");
  const now = useClock(props.visible && view.connected);
  const time = duration(props, now);
  const showKeypad = keypad && view.canKeypad;
  const title = props.facts?.name || view.title;
  const number = props.facts?.name && state.call?.number ? formatNumber(state.call.number) : null;
  return <Modal visible={props.visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={props.onMinimize}>
    <View style={[s.screen, { paddingTop: insets.top + space.s, paddingBottom: insets.bottom + space.l }]}>
      <View style={s.top}>
        <Pressable accessibilityRole="button" accessibilityLabel="Skryť obrazovku hovoru" hitSlop={8} onPress={props.onMinimize} style={({ pressed }) => [s.hide, pressed && { opacity: 0.6 }]}>
          <ChevronDown size={20} strokeWidth={2.4} color={palette.label} accessible={false} /><Text style={s.hideText}>Skryť</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={s.body} bounces={false}>
        <Text accessibilityRole="header" style={s.title}>{title}</Text>
        {number ? <Text selectable style={s.subtitle}>{number}</Text> : null}
        <Text accessibilityLiveRegion="polite" style={[s.status, { color: toneColor[view.tone] }]}>{[view.status, time].filter(Boolean).join(" · ")}</Text>
        {props.facts?.lineLabel ? <Text style={s.line}>Linka: {props.facts.lineLabel}</Text> : null}
        {(props.onDetail || props.onNewCase) && <View style={s.context}>
          {props.onDetail && <Pill icon={<Info size={15} strokeWidth={2.3} color={palette.brandInk} accessible={false} />} label="Detail hovoru" onPress={props.onDetail} />}
          {props.onNewCase && <Pill icon={<FilePlus2 size={15} strokeWidth={2.3} color={palette.brandInk} accessible={false} />} label="Nový prípad" onPress={props.onNewCase} />}
        </View>}
        {showKeypad ? <View style={s.keypad}>
          <Text accessibilityLabel={"Odoslané číslice " + (digits || "žiadne")} style={s.digits}>{digits || " "}</Text>
          {["123", "456", "789", "*0#"].map(row => <View key={row} style={s.keyRow}>{Array.from(row).map(digit =>
            <Pressable key={digit} accessibilityRole="button" accessibilityLabel={"Číslica " + digit} onPress={() => { setDigits(value => (value + digit).slice(-24)); void phone.dtmf(digit); }}
              style={({ pressed }) => [s.key, pressed && { backgroundColor: palette.fillStrong }]}><Text style={s.keyText}>{digit}</Text></Pressable>)}</View>)}
          <Pressable accessibilityRole="button" accessibilityLabel="Skryť klávesnicu" onPress={() => setKeypad(false)} style={({ pressed }) => [s.textButton, pressed && { opacity: 0.6 }]}>
            <Text style={s.textButtonLabel}>Skryť klávesnicu</Text></Pressable>
        </View> : view.showControls && <View style={s.grid}>
          <Round label={state.muted ? "Mikrofón vyp." : "Stíšiť"} accessibilityLabel={state.muted ? "Zapnúť mikrofón" : "Stíšiť"} active={state.muted}
            icon={state.muted ? MicOff : Mic} onPress={() => { void phone.mute(); }} />
          <Round label="Klávesnica" icon={Grid3x3} disabled={!view.canKeypad} onPress={() => setKeypad(true)} />
          <Round label={state.speaker ? "Reproduktor" : "Nahlas"} accessibilityLabel={state.speaker ? "Slúchadlo" : "Nahlas"} active={state.speaker} icon={Volume2} onPress={() => { void phone.speaker(); }} />
          {view.canHold && <Round label={view.holdPending ? "Overujem…" : view.held ? "Obnoviť" : "Podržať"} accessibilityLabel={view.holdPending ? "Overujem podržanie…" : view.held ? "Obnoviť hovor" : "Podržať hovor"}
            active={view.held} disabled={view.holdPending} icon={view.held ? Play : Pause} onPress={() => { void phone.hold(); }} />}
        </View>}
        {view.holdUncertain && <View style={s.notice}>
          <Text style={s.noticeText}>Výsledok zmeny ešte overujeme. Hovor môžete ukončiť.</Text>
          <Pressable accessibilityRole="button" onPress={() => { void phone.refreshHold(); }} style={({ pressed }) => [s.textButton, pressed && { opacity: 0.6 }]}>
            <Text style={s.textButtonLabel}>Overiť stav podržania</Text></Pressable>
        </View>}
        {state.error ? <View style={s.notice}><ErrorNotice message={state.error} /></View> : null}
      </ScrollView>
      <View style={s.bottom}>
        {view.showAnswer && <Big label="Prijať" color={palette.green} icon={Phone} onPress={() => { void phone.answer(); }} />}
        <Big label={view.endLabel} color={palette.red} icon={PhoneOff} onPress={() => { void phone.end(); }} />
      </View>
    </View>
  </Modal>;
}

function Pill({ icon, label, onPress }: { icon: ReactNode; label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }} style={({ pressed }) => [s.pill, pressed && { opacity: 0.7 }]}>
    {icon}<Text maxFontSizeMultiplier={1.3} style={s.pillLabel}>{label}</Text>
  </Pressable>;
}
function Round({ label, accessibilityLabel, icon: Icon, onPress, active, disabled }: {
  label: string; accessibilityLabel?: string; icon: typeof Mic; onPress: () => void; active?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(active) }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [s.round, disabled && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}>
    <View style={[s.roundIcon, active && { backgroundColor: palette.label }]}><Icon size={26} strokeWidth={2.2} color={active ? "#FFFFFF" : palette.label} accessible={false} /></View>
    <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.roundLabel}>{label}</Text>
  </Pressable>;
}
function Big({ label, color, icon: Icon, onPress }: { label: string; color: string; icon: typeof Mic; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [s.big, pressed && { opacity: 0.8 }]}>
    <View style={[s.bigIcon, { backgroundColor: color }]}><Icon size={30} strokeWidth={2.4} color="#FFFFFF" accessible={false} /></View>
    <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.roundLabel}>{label}</Text>
  </Pressable>;
}

const s = StyleSheet.create({
  strip: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: space.l, paddingVertical: 6 },
  stripTitle: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, fontWeight: "600", color: "#FFFFFF" },
  stripStatus: { flexShrink: 0, fontSize: 13, lineHeight: 18, fontWeight: "500", color: "#FFFFFF", fontVariant: ["tabular-nums"] },
  screen: { flex: 1, backgroundColor: palette.background },
  top: { flexDirection: "row", paddingHorizontal: space.l, minHeight: 44, alignItems: "center" },
  hide: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44, paddingRight: space.m },
  hideText: { ...type.body, fontWeight: "600", color: palette.label },
  body: { paddingHorizontal: space.xl, paddingTop: space.l, gap: space.s, alignItems: "center" },
  title: { ...type.title, color: palette.label, textAlign: "center" },
  subtitle: { ...type.body, color: palette.secondaryLabel, textAlign: "center" },
  status: { fontSize: 17, lineHeight: 22, fontWeight: "600", textAlign: "center", fontVariant: ["tabular-nums"] },
  line: { ...type.subhead, color: palette.secondaryLabel, textAlign: "center" },
  context: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.s, marginTop: space.m },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, borderRadius: 18, paddingHorizontal: 14, backgroundColor: palette.brandSoft },
  pillLabel: { fontSize: 14, lineHeight: 18, fontWeight: "600", color: palette.brandInk },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.l, marginTop: space.xl, maxWidth: 320 },
  round: { width: 84, alignItems: "center", gap: 6 },
  roundIcon: { width: 68, height: 68, borderRadius: 34, backgroundColor: palette.card, alignItems: "center", justifyContent: "center" },
  roundLabel: { ...type.caption, color: palette.label, textAlign: "center" },
  keypad: { alignItems: "center", gap: space.s, marginTop: space.l },
  digits: { fontSize: 22, lineHeight: 28, fontWeight: "600", letterSpacing: 2, color: palette.label, minHeight: 28, fontVariant: ["tabular-nums"] },
  keyRow: { flexDirection: "row", gap: space.l },
  key: { width: 68, height: 68, borderRadius: 34, backgroundColor: palette.card, alignItems: "center", justifyContent: "center" },
  keyText: { fontSize: 28, lineHeight: 34, fontWeight: "500", color: palette.label },
  textButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.m },
  textButtonLabel: { ...type.body, fontWeight: "600", color: palette.brandInk, textAlign: "center" },
  notice: { alignSelf: "stretch", marginTop: space.m, gap: 4 },
  noticeText: { ...type.subhead, color: palette.secondaryLabel, textAlign: "center" },
  bottom: { flexDirection: "row", justifyContent: "center", gap: 64, paddingTop: space.m },
  big: { alignItems: "center", gap: 6, minWidth: 84 },
  bigIcon: { width: 74, height: 74, borderRadius: 37, alignItems: "center", justifyContent: "center" },
});
