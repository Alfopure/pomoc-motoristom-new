import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { UserRound } from "lucide-react-native";
import { palette, space, type } from "../design/tokens";
import { Group, Row } from "../design/list";
import { Tag } from "../design/detail";
import { ErrorNotice, Loading } from "../ui";
import { MobileApiError } from "../lib/api";
import type { VoiceTransferTarget } from "../voice/api";
import type { DispatchPhone } from "../voice/phone";

/** Progress of a transfer, kept by the call screen so it survives the panel. */
export type TransferProgress = { busy: string | null; sent: { name: string; queued: boolean } | null; error: string | null };

/** Blind transfer of the phone's own call, in place of the call controls. Colleagues
 * who cannot take it stay listed, disabled, with the web's badge saying why. */
export function TransferPanel({ phone, progress, onPick, onClose }: {
  phone: DispatchPhone; progress: TransferProgress; onPick: (target: VoiceTransferTarget) => void; onClose: () => void;
}) {
  const [targets, setTargets] = useState<VoiceTransferTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    phone.transferTargets().then(value => { if (current) { setTargets(value); setError(null); } })
      .catch((caught: unknown) => { if (current) { setTargets([]); setError(caught instanceof MobileApiError ? caught.message : "Kolegov sa nepodarilo načítať."); } });
    return () => { current = false; };
  }, [phone, attempt]);
  const reload = () => { setTargets(null); setError(null); setAttempt(value => value + 1); };
  const locked = Boolean(progress.busy || progress.sent);
  return <View style={s.panel}>
    <Text accessibilityRole="header" style={s.heading}>Prepojiť na kolegu</Text>
    {progress.sent ? <Text style={s.sent}>{progress.sent.queued ? "Prepojenie na " + progress.sent.name + " sa pripravuje." : "Hovor sa prepája na " + progress.sent.name + "."} Váš telefón sa odpojí.</Text>
      : progress.busy ? <Loading label={"Prepájam na " + progress.busy + "…"} /> : null}
    {progress.error && <View style={s.notice}><ErrorNotice message={progress.error} /></View>}
    {error && <View style={s.notice}><ErrorNotice message={error} onRetry={reload} /></View>}
    {targets === null ? <Loading label="Načítavam kolegov…" />
      : targets.length === 0 ? (!error && <Text style={s.empty}>Žiadny kolega nie je prihlásený.</Text>)
        : <Group style={s.list}>{targets.map((target, index) => <Row key={target.profileId} first={index === 0} title={target.displayName}
          leading={<View style={s.avatar}><UserRound size={17} strokeWidth={2.3} color={palette.secondaryLabel} accessible={false} /></View>}
          trailing={<Tag text={target.label} tone={target.available ? "green" : "gray"} />}
          disabled={!target.available || locked}
          accessibilityLabel={target.available ? "Prepojiť na " + target.displayName + ", " + target.label : target.displayName + ", nedostupný: " + target.label}
          onPress={() => onPick(target)} />)}</Group>}
    <Pressable accessibilityRole="button" accessibilityLabel="Späť na ovládanie hovoru" disabled={Boolean(progress.busy)} onPress={onClose}
      style={({ pressed }) => [s.back, progress.busy && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}>
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
