import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Phone, PhoneCall } from "lucide-react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MobileMe } from "../../../src/lib/mobile-api";
import type { MobileCallContextTarget } from "../../../src/lib/mobile-call-context";
import { MobileApiError, type MobileApi } from "../lib/api";
import { callStatus, dialable, formatNumber, formatTime, presenceLabels } from "../lib/display";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "../ui";
import { palette } from "../design/tokens";
import { Row } from "../design/list";
import { PhoneReadinessCard } from "../voice/readiness-ui";
import { ColleaguesCard } from "../voice/colleagues-ui";
import type { DispatchPhone, PhoneState } from "../voice/phone";
import { checkDialTarget } from "../callbacks/model";

const errorMessage = (error: unknown) => error instanceof MobileApiError ? error.message : "Údaje sa nepodarilo načítať. Skúste znova.";

/** Ústredňa inside the Hovory module: own status, calls on the account, dialing and colleagues. */
export function Console({ api, me, queryKey, active, number, onNumber, phone, phoneState, onCallContext }: {
  api: MobileApi; me: MobileMe; queryKey: string[]; active: boolean; number: string; onNumber: (value: string) => void;
  phone: DispatchPhone | null; phoneState: PhoneState; onCallContext: (target: MobileCallContextTarget) => void;
}) {
  const cache = useQueryClient();
  const [changingPresence, setChangingPresence] = useState(false);
  const [checkingTarget, setCheckingTarget] = useState(false);
  // An error describes the number it was checked for; editing the number hides it.
  const [targetError, setTargetError] = useState<{ number: string; message: string } | null>(null);
  // The directory may forbid ringing a number back or name a verified
  // replacement. The server enforces the same decision when the call starts.
  async function dial() {
    const value = number.trim();
    if (!phone || checkingTarget) return;
    setCheckingTarget(true); setTargetError(null);
    try {
      // The check ends before dialing: the button reads "Vytáčam…" while the call is set up.
      const decision = await checkDialTarget(() => api.callTarget(me.profileId, value), () => setCheckingTarget(false));
      if (decision.kind === "blocked") setTargetError({ number, message: decision.message });
      else if (decision.kind === "dial") await phone.dial(value);
      else Alert.alert(decision.title, decision.message, [{ text: "Zrušiť", style: "cancel" }, { text: "Zavolať", onPress: () => { void phone.dial(value, decision.verificationId); } }]);
    } catch (error) { setTargetError({ number, message: errorMessage(error) }); }
  }
  // The shell polls this key every 30 s for the status shown on every screen.
  const query = useQuery({ queryKey: [...queryKey, "console", me.profileId], queryFn: ({ signal }) => api.console(me.profileId, signal), enabled: active });
  const readiness = useQuery({ queryKey: [...queryKey, "voice-readiness", me.profileId], queryFn: ({ signal }) => api.voiceReadiness(me.profileId, signal), enabled: active, refetchInterval: active ? 30_000 : false });
  function refreshPhone() {
    void Promise.allSettled([query.refetch(), readiness.refetch(), phone?.refreshDiagnostics(),
      cache.invalidateQueries({ queryKey: [...queryKey, "callback-summary", me.profileId] }), cache.invalidateQueries({ queryKey: [...queryKey, "voice-colleagues", me.profileId] })]);
  }
  async function presence(status: "available" | "paused") {
    if (!phone || changingPresence) return;
    setChangingPresence(true);
    try { await phone.presence(status); await query.refetch(); } catch { /* Phone displays the authorized action's error. */ }
    finally { setChangingPresence(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching || readiness.isRefetching || phoneState.checkingDiagnostics} onRefresh={refreshPhone} />}>
    {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} /> : query.data && <>
      <Card><Text style={styles.label}>Váš stav v ústredni</Text><View style={styles.row}>
        <View style={[s.presenceIndicator, { backgroundColor: query.data.presence.status === "available" ? palette.greenSoft : colors.surfaceMuted }]}>
          <View style={[s.dot, { backgroundColor: query.data.presence.status === "available" ? colors.success : colors.muted }]} />
        </View><Text style={s.presenceTitle}>{presenceLabels[query.data.presence.status]}</Text></View>
        <Text style={styles.muted}>Aktualizované {formatTime(query.data.checkedAt)}</Text>
        {phoneState.registration === "registered" && <View style={styles.row}>{(["available", "paused"] as const).map(status => <View key={status} style={{ flex: 1 }}>
          <Button label={presenceLabels[status]} secondary disabled={changingPresence || phoneState.microphonePermission === "denied" || Boolean(phoneState.call || phoneState.termination) || query.data.presence.status === status}
            onPress={() => { void presence(status); }} />
        </View>)}</View>}
      </Card>
      {query.data.activeCalls.length > 0 && <><Text accessibilityRole="header" style={styles.subheading}>Hovory na vašom účte</Text>
        <View style={s.group}>{query.data.activeCalls.map((call, index) => <Row key={call.id} first={index === 0} title={call.contactName || call.name || formatNumber(call.number)}
          subtitle={[callStatus(call.state), call.lineLabel].filter(Boolean).join(" · ")} accessibilityLabel={["Detail hovoru " + (call.contactName || call.name || formatNumber(call.number)), callStatus(call.state), call.lineLabel].filter(Boolean).join(", ")}
          leading={<View style={s.callIcon}><Phone size={15} strokeWidth={2.3} color={palette.greenText} accessible={false} /></View>}
          onPress={() => onCallContext({ kind: "session", id: call.id })} trailing={<Text style={s.chevron}>›</Text>} />)}</View></>}
    </>}
    {phoneState.call && !query.data?.activeCalls.some(call => call.id === phoneState.call?.sessionId) && <Button label="Detail aktuálneho hovoru" secondary
      onPress={() => { if (phoneState.call) onCallContext({ kind: "session", id: phoneState.call.sessionId }); }} />}
    {phoneState.retryTarget && !phoneState.dialing && <Card><Text style={styles.subheading}>Nepotvrdené volanie</Text>
      <Text style={styles.text}>{phoneState.retryTarget.kind === "internal" ? phoneState.retryTarget.name : formatNumber(phoneState.retryTarget.number)}</Text>
      {phoneState.retryTarget.kind === "callback" && <Text style={styles.muted}>Spätné volanie z fronty požiadaviek.</Text>}
      {phoneState.retryTarget.kind === "external" && phoneState.retryTarget.verificationId && <Text style={styles.muted}>Volanie na overené náhradné číslo kontaktu.</Text>}
      <Text style={styles.muted}>Zopakujeme pôvodný pokus o volanie. Tým sa nevytvorí druhý súbežný pokus.</Text>
      <Button label="Zopakovať pôvodné volanie" disabled={!phone || phoneState.registration !== "registered" || phoneState.cancelingAttempt || phoneState.microphonePermission === "denied" || Boolean(phoneState.call || phoneState.termination)}
        onPress={() => { void phone?.retryDial(); }} />
      <Button label={phoneState.cancelingAttempt ? "Ukončujem pôvodný pokus…" : "Ukončiť pôvodný pokus"} secondary
        disabled={!phone || phoneState.registration !== "registered" || phoneState.cancelingAttempt || Boolean(phoneState.call || phoneState.termination)} onPress={() => { void phone?.cancelAttempt(); }} />
    </Card>}
    <Card><View style={styles.row}><View style={s.smallEmblem}><PhoneCall size={18} color={colors.ink} accessible={false} /></View><Text style={styles.subheading}>Nový hovor</Text></View>
      <TextInput accessibilityLabel="Telefónne číslo" placeholder="Telefónne číslo" placeholderTextColor={colors.muted}
      selectionColor={colors.brand} keyboardType="phone-pad" maxLength={40} value={number} onChangeText={onNumber} style={[styles.input, s.phoneInput]} />
      {targetError?.number === number && <ErrorNotice message={targetError.message} />}
      <Button label={checkingTarget ? "Overujem číslo…" : phoneState.dialing ? "Vytáčam…" : "Zavolať"} disabled={!phone || checkingTarget || phoneState.registration !== "registered" || phoneState.microphonePermission === "denied" || Boolean(phoneState.retryTarget) || !dialable(number) || phoneState.dialing || phoneState.cancelingAttempt || Boolean(phoneState.call || phoneState.termination)}
        onPress={() => { void dial(); }} />
    </Card>
    <PhoneReadinessCard state={phoneState} configuration={readiness.data} configurationError={readiness.isError}
      presence={query.isError ? undefined : query.data?.presence.status} checking={readiness.isFetching || phoneState.checkingDiagnostics}
      onRefresh={refreshPhone} onConnect={() => { void phone?.connect(); }} onTakeover={() => Alert.alert("Prevziať telefón?", "Druhý mobil sa odpojí od ústredne.", [
        { text: "Zrušiť", style: "cancel" }, { text: "Prevziať", onPress: () => { void phone?.connect(true); } },
      ])} />
    <ColleaguesCard key={me.profileId} api={api} profileId={me.profileId} queryKey={queryKey} active={active} phone={phone} state={phoneState} />
    </ScrollView>
  </KeyboardAvoidingView>;
}
const s = StyleSheet.create({
  phoneInput: { fontSize: 20, letterSpacing: 0.3, minHeight: 52, fontVariant: ["tabular-nums"] },
  smallEmblem: { width: 30, height: 30, borderRadius: 9, backgroundColor: palette.brandSoft, alignItems: "center", justifyContent: "center" },
  presenceIndicator: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  presenceTitle: { fontSize: 20, lineHeight: 25, fontWeight: "700", letterSpacing: -0.4, color: colors.ink, flexShrink: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  // The page already insets its content; the call group needs no own margin.
  group: { backgroundColor: palette.card, borderRadius: 16, overflow: "hidden" },
  callIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: palette.greenSoft, alignItems: "center", justifyContent: "center" },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
});
