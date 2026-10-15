import { Text, View } from "react-native";
import { useState } from "react";
import { Button, Card, ErrorNotice, styles } from "../ui";
import { formatNumber } from "../lib/display";
import type { DispatchPhone, PhoneState } from "./phone";

/** Stays above the tab content, so navigating history cannot hide a call. */
export function CallPanel({ phone, state }: { phone: DispatchPhone | null; state: PhoneState }) {
  const [keypad, setKeypad] = useState(false);
  if (!phone || (!state.call && !state.termination)) return null;
  const call = state.call;
  const ringing = call?.state === "RINGING" && !call.outgoing;
  const recovering = call?.state === "DROPPED" || call?.state === "RECONNECTING";
  const holdPending = state.nativeSyncPending || state.holdPhase !== "idle" || call?.media?.state === "pending";
  const held = call?.media?.state === "held" && !holdPending;
  const canUseKeypad = call?.connected && call.media?.state !== "held" && !holdPending;
  return <View style={{ paddingHorizontal: 20, paddingTop: 12 }}><Card>
    <Text style={styles.label}>{state.termination ? "Ukončujem hovor…" : recovering ? "Obnovujem spojenie…" : ringing ? "Prichádzajúci hovor" : holdPending ? "Overujem stav podržania…" : held ? "Hovor je podržaný" : call?.connected ? "Prebieha hovor" : "Spájam hovor…"}</Text>
    {call && <Text style={styles.subheading}>{call.displayName || formatNumber(call.number)}</Text>}
    {ringing && !state.termination && <Button label="Prijať" onPress={() => { void phone.answer(); }} />}
    {call?.connected && !recovering && !state.termination && <>
      <View style={styles.row}>
        <View style={{ flex: 1 }}><Button label={state.muted ? "Zapnúť mikrofón" : "Stíšiť"} secondary onPress={() => { void phone.mute(); }} /></View>
        <View style={{ flex: 1 }}><Button label={state.speaker ? "Slúchadlo" : "Nahlas"} secondary onPress={() => { void phone.speaker(); }} /></View>
      </View>
      {(call.media?.canHold || holdPending) && <Button label={holdPending ? "Overujem podržanie…" : held ? "Obnoviť hovor" : "Podržať hovor"}
        secondary disabled={holdPending} onPress={() => { void phone.hold(); }} />}
      {state.holdPhase === "uncertain" && <>
        <Text style={styles.muted}>Výsledok zmeny ešte overujeme. Hovor môžete ukončiť.</Text>
        <Button label="Overiť stav podržania" secondary onPress={() => { void phone.refreshHold(); }} />
      </>}
      {canUseKeypad && <Button label={keypad ? "Skryť klávesnicu" : "Klávesnica"} secondary onPress={() => setKeypad(value => !value)} />}
      {keypad && canUseKeypad && ["123", "456", "789", "*0#"].map(row => <View key={row} style={styles.row}>{Array.from(row).map(digit => <View key={digit} style={{ flex: 1 }}>
        <Button label={digit} secondary onPress={() => { void phone.dtmf(digit); }} />
      </View>)}</View>)}
    </>}
    {state.error && <ErrorNotice message={state.error} />}
    <Button label={state.termination ? "Zopakovať ukončenie" : ringing ? "Odmietnuť" : "Ukončiť"} secondary onPress={() => { void phone.end(); }} />
  </Card></View>;
}
