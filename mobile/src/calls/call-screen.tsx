import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Alert, Keyboard, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, FilePlus2, Forward, Grid3x3, Info, Mic, MicOff, Pause, Phone, PhoneOff, Play, TriangleAlert, Volume2 } from "lucide-react-native";
import { palette, space, type } from "../design/tokens";
import { ErrorNotice } from "../ui";
import { MobileApiError } from "../lib/api";
import { formatNumber } from "../lib/display";
import { elapsed } from "../shell/call-bar-model";
import type { DispatchPhone, PhoneState } from "../voice/phone";
import { recordingView, type CallView } from "./call-screen-model";
import { TransferPanel } from "./transfer-panel";

/** Server facts about the phone's own call: the line the customer called, its
 * partner and the directory contact for the customer's number. */
export type CallFacts = { lineLabel: string | null; partner: string | null; contact: string | null };
type Common = { view: CallView; facts: CallFacts | null; connectedAt: number | null };

/** Moves VoiceOver to an element that appears in place of another one. */
function useAccessibilityFocus<T extends View | Text>(when: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!when) return;
    const timer = setTimeout(() => { if (ref.current) AccessibilityInfo.sendAccessibilityEvent?.(ref.current, "focus"); }, 250);
    return () => clearTimeout(timer);
  }, [when]);
  return ref;
}
function useClock(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(Date.now()), first = setTimeout(tick, 0), timer = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [running]);
  return now;
}
/** Talk time on this phone: from the moment it saw the call connected. */
function duration({ view, connectedAt }: Common, now: number) {
  return view.connected && connectedAt !== null ? elapsed(new Date(connectedAt).toISOString(), now) : "";
}
const toneColor = { ringing: palette.redText, active: palette.greenText, held: palette.orangeText, working: palette.secondaryLabel } as const;
const titleOf = ({ view, facts }: Common) => facts?.contact || view.title;
/** The line and, when the line's name does not already say it, its partner. */
function lineOf(facts: CallFacts | null) {
  const partner = facts?.partner && !(facts.lineLabel ?? "").toLowerCase().includes(facts.partner.toLowerCase()) ? "Partner: " + facts.partner : null;
  return [facts?.lineLabel ? "Linka: " + facts.lineLabel : null, partner].filter(Boolean).join(" · ");
}

/** Above the app while the call screen is hidden; one tap brings the controls back.
 * An error or an unconfirmed hold says so here instead of hiding behind the strip. */
export function CallStrip(props: Common & { attention: boolean; focus: boolean; onExpand: () => void }) {
  const now = useClock(props.view.connected);
  const ref = useAccessibilityFocus<View>(props.focus);
  const time = duration(props, now);
  const title = titleOf(props);
  const status = props.attention ? "Skontrolujte hovor" : time ? props.view.status + " · " + time : props.view.status;
  return <Pressable ref={ref} accessibilityRole="button" accessibilityLabel={"Hovor: " + title + ", " + (props.attention ? "vyžaduje pozornosť" : props.view.status + (time ? ", " + time : "")) + ". Otvoriť ovládanie hovoru"}
    onPress={props.onExpand} style={({ pressed }) => [s.strip, { backgroundColor: props.attention ? palette.redText : toneColor[props.view.tone] }, pressed && { opacity: 0.85 }]}>
    {props.attention ? <TriangleAlert size={15} strokeWidth={2.6} color="#FFFFFF" accessible={false} /> : <Phone size={15} strokeWidth={2.6} color="#FFFFFF" accessible={false} />}
    <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.stripTitle}>{title}</Text>
    <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={s.stripStatus}>{status}</Text>
  </Pressable>;
}

/** Full-screen controls of the phone's own call. Every action keeps a visible label.
 * A layer inside the app, not a system modal: iOS refuses a second modal while
 * another one is still closing, which would leave the call without controls. */
export function CallScreen(props: Common & {
  visible: boolean; phone: DispatchPhone; state: PhoneState; onMinimize: () => void;
  onDetail: (() => void) | null; onNewCase: (() => void) | null;
}) {
  const { view, phone, state } = props;
  const insets = useSafeAreaInsets();
  // A narrow phone keeps three controls in a row, so Prepojiť does not drop below the fold.
  const compact = useWindowDimensions().width < 360;
  const [panel, setPanel] = useState<"controls" | "keypad" | "transfer">("controls");
  const [digits, setDigits] = useState("");
  const [stopping, setStopping] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const now = useClock(props.visible && view.connected);
  const titleRef = useAccessibilityFocus<Text>(props.visible);
  // A keyboard left open by a form would cover the answer and end buttons.
  useEffect(() => { if (props.visible) Keyboard.dismiss(); }, [props.visible]);
  if (!props.visible) return null;
  const time = duration(props, now);
  const showKeypad = panel === "keypad" && view.canKeypad;
  const showTransfer = panel === "transfer" && view.canTransfer;
  const recording = recordingView(state, view);
  // A caller may object to recording at any time; the stop is confirmed once, a retry is not.
  function stopRecording() {
    if (!recording?.canStop || stopping) return;
    const retry = recording.retry;
    const run = async () => {
      setStopping(true); setRecordingError(null);
      try { await phone.stopRecording(retry); }
      catch (error) { setRecordingError(error instanceof MobileApiError ? error.message : "Zastavenie nahrávania nie je potvrdené."); }
      finally { setStopping(false); }
    };
    if (retry) { void run(); return; }
    Alert.alert("Zastaviť nahrávanie?", "Nahrávanie tohto hovoru sa už automaticky neobnoví.", [
      { text: "Zrušiť", style: "cancel" }, { text: "Zastaviť", style: "destructive", onPress: () => { void run(); } }]);
  }
  const title = titleOf(props);
  const formatted = state.call?.number ? formatNumber(state.call.number) : null;
  const number = formatted && formatted !== title ? formatted : null;
  const line = lineOf(props.facts);
  return <View accessibilityViewIsModal style={[StyleSheet.absoluteFill, s.layer]}>
    {/* The app frame already keeps the top clear of the status bar, not the bottom. */}
    <View style={[s.screen, { paddingTop: space.s, paddingBottom: insets.bottom + space.l }]}>
      <View style={s.top}>
        <Pressable accessibilityRole="button" accessibilityLabel="Skryť obrazovku hovoru" hitSlop={8} onPress={props.onMinimize} style={({ pressed }) => [s.hide, pressed && { opacity: 0.6 }]}>
          <ChevronDown size={20} strokeWidth={2.4} color={palette.label} accessible={false} /><Text style={s.hideText}>Skryť</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={[s.body, compact && s.bodyCompact]} bounces={false}>
        <Text ref={titleRef} accessibilityRole="header" style={s.title}>{title}</Text>
        {number ? <Text selectable style={s.subtitle}>{number}</Text> : null}
        <Text accessibilityLiveRegion="polite" style={[s.status, { color: toneColor[view.tone] }]}>{[view.status, time].filter(Boolean).join(" · ")}</Text>
        {line ? <Text style={s.line}>{line}</Text> : null}
        {recording && <View style={s.recording}>
          <View style={s.recordingState}>
            <View style={[s.recordingDot, { backgroundColor: recording.tone === "red" ? palette.red : recording.tone === "orange" ? palette.orange : palette.tertiaryLabel }]} />
            <Text accessibilityLiveRegion="polite" style={s.recordingLabel}>{recording.label}</Text>
          </View>
          {recording.canStop && <Pressable accessibilityRole="button" accessibilityState={{ disabled: stopping }} disabled={stopping} onPress={stopRecording}
            style={({ pressed }) => [s.recordingButton, stopping && { opacity: 0.5 }, pressed && { opacity: 0.7 }]}>
            <Text style={s.recordingButtonLabel}>{stopping ? "Overujem zastavenie…" : recording.retry ? "Znova overiť zastavenie" : "Zastaviť nahrávanie"}</Text>
          </Pressable>}
        </View>}
        {recording?.unconfirmed && <Text style={s.noticeText}>Zastavenie ešte nie je potvrdené. Volajúcemu zatiaľ nehovorte, že sa nenahráva.</Text>}
        {recordingError && <View style={s.notice}><ErrorNotice message={recordingError} /></View>}
        {(props.onDetail || props.onNewCase) && <View style={s.context}>
          {props.onDetail && <Pill compact={compact} icon={<Info size={15} strokeWidth={2.3} color={palette.brandInk} accessible={false} />} label="Detail hovoru" onPress={props.onDetail} />}
          {props.onNewCase && <Pill compact={compact} icon={<FilePlus2 size={15} strokeWidth={2.3} color={palette.brandInk} accessible={false} />} label="Nový prípad" onPress={props.onNewCase} />}
        </View>}
        {showKeypad ? <View style={s.keypad}>
          <Text accessibilityLabel={"Odoslané číslice " + (digits || "žiadne")} style={s.digits}>{digits || " "}</Text>
          {["123", "456", "789", "*0#"].map(row => <View key={row} style={s.keyRow}>{Array.from(row).map(digit =>
            <Pressable key={digit} accessibilityRole="button" accessibilityLabel={"Číslica " + digit} onPress={() => { setDigits(value => (value + digit).slice(-24)); void phone.dtmf(digit); }}
              style={({ pressed }) => [s.key, pressed && { backgroundColor: palette.fillStrong }]}><Text style={s.keyText}>{digit}</Text></Pressable>)}</View>)}
          <Pressable accessibilityRole="button" accessibilityLabel="Skryť klávesnicu" onPress={() => setPanel("controls")} style={({ pressed }) => [s.textButton, pressed && { opacity: 0.6 }]}>
            <Text style={s.textButtonLabel}>Skryť klávesnicu</Text></Pressable>
        </View> : showTransfer ? <TransferPanel phone={phone} onClose={() => setPanel("controls")} />
          : view.showControls && <View style={s.grid}>
          <Round label={state.muted ? "Mikrofón vyp." : "Stíšiť"} accessibilityLabel={state.muted ? "Zapnúť mikrofón" : "Stíšiť"} active={state.muted}
            icon={state.muted ? MicOff : Mic} onPress={() => { void phone.mute(); }} />
          <Round label="Klávesnica" icon={Grid3x3} disabled={!view.canKeypad} onPress={() => setPanel("keypad")} />
          <Round label={state.speaker ? "Reproduktor" : "Nahlas"} accessibilityLabel={state.speaker ? "Slúchadlo" : "Nahlas"} active={state.speaker} icon={Volume2} onPress={() => { void phone.speaker(); }} />
          {view.canHold && <Round label={view.holdPending ? "Overujem…" : view.held ? "Obnoviť" : "Podržať"} accessibilityLabel={view.holdPending ? "Overujem podržanie…" : view.held ? "Obnoviť hovor" : "Podržať hovor"}
            active={view.held} disabled={view.holdPending} icon={view.held ? Play : Pause} onPress={() => { void phone.hold(); }} />}
          <Round label="Prepojiť" accessibilityLabel="Prepojiť hovor na kolegu" icon={Forward} disabled={!view.canTransfer} onPress={() => setPanel("transfer")} />
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
  </View>;
}

function Pill({ icon, label, onPress, compact }: { icon: ReactNode; label: string; onPress: () => void; compact: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }} style={({ pressed }) => [s.pill, compact && s.pillCompact, pressed && { opacity: 0.7 }]}>
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
  layer: { zIndex: 100, elevation: 100 },
  screen: { flex: 1, backgroundColor: palette.background },
  top: { flexDirection: "row", paddingHorizontal: space.l, minHeight: 44, alignItems: "center" },
  hide: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44, paddingRight: space.m },
  hideText: { ...type.body, fontWeight: "600", color: palette.label },
  body: { paddingHorizontal: space.xl, paddingTop: space.l, gap: space.s, alignItems: "center" },
  bodyCompact: { paddingHorizontal: space.l },
  title: { ...type.title, color: palette.label, textAlign: "center" },
  subtitle: { ...type.body, color: palette.secondaryLabel, textAlign: "center" },
  status: { fontSize: 17, lineHeight: 22, fontWeight: "600", textAlign: "center", fontVariant: ["tabular-nums"] },
  line: { ...type.subhead, color: palette.secondaryLabel, textAlign: "center" },
  context: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.s, marginTop: space.m },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, borderRadius: 18, paddingHorizontal: 14, backgroundColor: palette.brandSoft },
  pillCompact: { gap: 4, paddingHorizontal: 10 },
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
  recording: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: space.s, marginTop: space.xs },
  recordingState: { flexDirection: "row", alignItems: "center", gap: 6 },
  recordingDot: { width: 9, height: 9, borderRadius: 5 },
  recordingLabel: { ...type.subhead, fontWeight: "600", color: palette.label },
  recordingButton: { minHeight: 36, justifyContent: "center", borderRadius: 18, paddingHorizontal: 14, backgroundColor: palette.redSoft },
  recordingButtonLabel: { fontSize: 14, lineHeight: 18, fontWeight: "600", color: palette.redText },
  noticeText: { ...type.subhead, color: palette.secondaryLabel, textAlign: "center" },
  bottom: { flexDirection: "row", justifyContent: "center", gap: 64, paddingTop: space.m },
  big: { alignItems: "center", gap: 6, minWidth: 84 },
  bigIcon: { width: 74, height: 74, borderRadius: 37, alignItems: "center", justifyContent: "center" },
});
