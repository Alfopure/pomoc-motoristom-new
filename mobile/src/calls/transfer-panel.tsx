import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { UserRound } from "lucide-react-native";
import { palette, space, type } from "../design/tokens";
import { Group, Row } from "../design/list";
import { Tag } from "../design/detail";
import { ErrorNotice, Loading } from "../ui";
import { MobileApiError } from "../lib/api";
import type { VoiceTransferTarget } from "../voice/api";
import type { DispatchPhone } from "../voice/phone";

const message = (error: unknown, fallback: string) => error instanceof MobileApiError ? error.message : fallback;

/** Blind transfer of the phone's own call, in place of the call controls. Colleagues
 * who cannot take it stay listed, disabled, with the web's badge saying why. */
export function TransferPanel({ phone, onClose }: { phone: DispatchPhone; onClose: () => void }) {
  const [targets, setTargets] = useState<VoiceTransferTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    phone.transferTargets().then(value => { if (current) { setTargets(value); setError(null); } })
      .catch((caught: unknown) => { if (current) { setTargets([]); setError(message(caught, "Kolegov sa nepodarilo načítať.")); } });
    return () => { current = false; };
  }, [phone, attempt]);
  async function transfer(target: VoiceTransferTarget) {
    setBusy(target.profileId); setError(null);
    try { await phone.transfer(target.profileId); setSent(target.displayName); }
    catch (caught) { setError(message(caught, "Prepojenie hovoru sa nepodarilo potvrdiť.")); }
    finally { setBusy(null); }
  }
  function confirm(target: VoiceTransferTarget) {
    if (busy || sent || !target.available) return;
    Alert.alert("Prepojiť hovor?", "Hovor prepojíme na " + target.displayName + ". Váš telefón sa potom odpojí.", [
      { text: "Zrušiť", style: "cancel" }, { text: "Prepojiť", onPress: () => { void transfer(target); } }]);
  }
  const reload = () => { setTargets(null); setError(null); setAttempt(value => value + 1); };
  return <View style={s.panel}>
    <Text accessibilityRole="header" style={s.heading}>Prepojiť na kolegu</Text>
    {sent ? <Text accessibilityRole="alert" style={s.sent}>Hovor sa prepája na {sent}. Váš telefón sa odpojí.</Text>
      : busy ? <Loading label="Prepájam hovor…" /> : null}
    {error && <View style={s.notice}><ErrorNotice message={error} onRetry={targets?.length ? undefined : reload} /></View>}
    {targets === null ? <Loading label="Načítavam kolegov…" />
      : targets.length === 0 ? (!error && <Text style={s.empty}>Žiadny kolega nie je prihlásený.</Text>)
        : <Group style={s.list}>{targets.map((target, index) => <Row key={target.profileId} first={index === 0} title={target.displayName}
          leading={<View style={s.avatar}><UserRound size={17} strokeWidth={2.3} color={palette.secondaryLabel} accessible={false} /></View>}
          trailing={<Tag text={target.label} tone={target.available ? "green" : "gray"} />}
          disabled={!target.available || Boolean(busy) || Boolean(sent)}
          accessibilityLabel={target.available ? "Prepojiť na " + target.displayName + ", " + target.label : target.displayName + ", nedostupný: " + target.label}
          onPress={() => confirm(target)} />)}</Group>}
    <Pressable accessibilityRole="button" accessibilityLabel="Späť na ovládanie hovoru" disabled={Boolean(busy)} onPress={onClose}
      style={({ pressed }) => [s.back, busy && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}>
      <Text style={s.backLabel}>Späť na ovládanie</Text>
    </Pressable>
  </View>;
}

const s = StyleSheet.create({
  panel: { alignSelf: "stretch", gap: space.s, marginTop: space.l },
  heading: { ...type.headline, color: palette.label, textAlign: "center" },
  sent: { ...type.body, fontWeight: "600", color: palette.greenText, textAlign: "center" },
  notice: { alignSelf: "stretch" },
  empty: { ...type.subhead, color: palette.secondaryLabel, textAlign: "center" },
  list: { marginHorizontal: 0 },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: palette.fill, alignItems: "center", justifyContent: "center" },
  back: { minHeight: 44, justifyContent: "center", alignSelf: "center", paddingHorizontal: space.m },
  backLabel: { ...type.body, fontWeight: "600", color: palette.brandInk },
});
