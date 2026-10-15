import { useEffect } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import type { MobileCallContext, MobileCallContextTarget } from "../../../src/lib/mobile-call-context";
import { useAndroidBack } from "../lib/use-android-back";
import { callStatus, formatNumber, formatTime } from "../lib/display";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import { CopyValue } from "../cases/copy";
import { useToolRequest } from "../tools/use-request";
import type { CallContextApi } from "./api";
import { customerCallNumber } from "./number";
import { useForegroundVisit } from "../ui/foreground-visit";

export function CallContextPanel({ api, target, active, current, onBack, onOpenCase, onNewCase, onSelectNumber }: {
  api: CallContextApi; target: MobileCallContextTarget; active: boolean; current: () => boolean; onBack: () => void;
  onOpenCase: (id: string) => void; onNewCase: (number: string) => void; onSelectNumber: (number: string) => void;
}) {
  const state = useToolRequest<MobileCallContext>(active), { request } = state;
  const visit = useForegroundVisit(active, () => request.invalidate());
  const back = () => { if (visit.current()) onBack(); };
  const reload = () => { if (visit.current()) void request.run(signal => api.read(target, signal)); };
  useEffect(() => { if (active && visit.current()) void request.run(signal => api.read({ kind: target.kind, id: target.id }, signal)); }, [active, api, request, target.kind, target.id, visit]);
  useAndroidBack(active, back);
  const data = active && current() ? state.data : null;
  const allowed = () => visit.current() && current() && request.snapshot().data === data && data !== null;
  const phone = data ? customerCallNumber(data.call.direction, data.call.number) : null;
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={state.busy} onRefresh={reload} />}>
    <Button label="Späť na hovory" secondary onPress={back} />
    <Text accessibilityRole="header" style={styles.heading}>Detail hovoru</Text>
    {state.busy && <Loading label="Načítavam údaje hovoru…" />}
    {state.error && <ErrorNotice message={state.error} onRetry={state.remaining ? undefined : reload} />}
    {state.remaining > 0 && <Text style={styles.muted}>Ďalší pokus o {state.remaining} s.</Text>}
    {data && <>
      <Card><Text style={styles.subheading}>{data.call.name || formatNumber(data.call.number)}</Text>
        {data.call.number && <><Text selectable style={styles.text}>{formatNumber(data.call.number)}</Text><CopyValue label="Skopírovať číslo hovoru" value={data.call.number}
          scopeKey={[data.profileId, data.organizationId, data.target.kind, data.target.id].join(":")} active={active && current()} /></>}
        <Text style={styles.text}>{data.call.direction === "internal" ? "Interný hovor" : data.call.direction === "outbound" ? "Odchádzajúci hovor" : "Prichádzajúci hovor"} · {callStatus(data.call.status)}</Text>
        <Text style={styles.muted}>{formatTime(data.call.startedAt)}</Text>
        {data.call.lineLabel && <Text style={styles.text}>{data.call.lineLabel}</Text>}
        {data.call.operatorName && <Text style={styles.muted}>Dispečer: {data.call.operatorName}</Text>}
        {data.call.answeredAt && <Text style={styles.muted}>Prijatý: {formatTime(data.call.answeredAt)}</Text>}
        {data.call.endedAt && <Text style={styles.muted}>Ukončený: {formatTime(data.call.endedAt)}</Text>}
        {data.call.durationSeconds !== null && <Text style={styles.text}>Dĺžka: {Math.floor(data.call.durationSeconds / 60)}:{String(data.call.durationSeconds % 60).padStart(2, "0")}</Text>}
        <Text style={styles.muted}>Overené {formatTime(data.checkedAt)}</Text>
      </Card>
      <Text style={styles.subheading}>Prípad hovoru</Text>
      {data.linkedCase ? <Card><Text style={styles.subheading}>{data.linkedCase.caseNumber}</Text>
        <Text style={styles.text}>{data.linkedCase.statusLabel}</Text>
        {Boolean(data.linkedCase.summary) && <Text style={styles.text}>{data.linkedCase.summary}</Text>}
        {data.linkedCase.contactName && <Text style={styles.muted}>{data.linkedCase.contactName}</Text>}
        {data.linkedCase.licensePlate && <Text style={styles.text}>{data.linkedCase.licensePlate}</Text>}
        {data.linkedCase.ownerName && <Text style={styles.muted}>Dispečer: {data.linkedCase.ownerName}</Text>}
        <Button label="Otvoriť prípad hovoru" onPress={() => { if (allowed() && data.linkedCase) onOpenCase(data.linkedCase.id); }} />
      </Card> : <Card><Text style={styles.text}>{data.linkState === "unavailable" ? "Priradenie prípadu sa nepodarilo overiť. Obnovte detail hovoru." : "Hovor zatiaľ nemá priradený prípad."}</Text>
        {data.linkState === "unavailable" && <Button label="Overiť priradenie prípadu" secondary onPress={reload} />}</Card>}
      {phone && <View style={{ gap: 10 }}>
        <Button label="Vybrať číslo na volanie" secondary onPress={() => { if (allowed()) onSelectNumber(phone); }} />
        <Button label="Použiť číslo v novom prípade" secondary onPress={() => { if (allowed()) onNewCase(phone); }} />
        <Text style={styles.muted}>Číslo pred uložením potvrdíte vo formulári. Vytvorenie prípadu samo nepriradí tento hovor.</Text>
      </View>}
      {data.call.direction === "internal" && <Text style={styles.muted}>Interná linka sa nepoužíva ako telefón zákazníka.</Text>}
    </>}
  </ScrollView>;
}
