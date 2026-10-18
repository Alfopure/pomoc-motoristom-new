import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { FilePlus2, FolderOpen, PhoneForwarded } from "lucide-react-native";
import { ActionBar, DetailHeader, InfoRow, Tag } from "../design/detail";
import { Group, Row, SectionHeader } from "../design/list";
import { palette, space, type } from "../design/tokens";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import type { MobileCallContext, MobileCallContextTarget } from "../../../src/lib/mobile-call-context";
import { useAndroidBack } from "../lib/use-android-back";
import { useShellBack } from "../shell/back";
import { callStatus, formatNumber, formatTime } from "../lib/display";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import { CopyValue } from "../cases/copy";
import { useToolRequest } from "../tools/use-request";
import type { CallContextApi } from "./api";
import { customerCallNumber } from "./number";
import { useForegroundVisit } from "../ui/foreground-visit";
import { WrapUpSection, type WrapUpDependencies } from "./wrap-up-ui";

export function CallContextPanel({ api, target, active, current, onBack, backLabel = "Hovory", onOpenCase, onNewCase, onSelectNumber, wrapUp }: {
  api: CallContextApi; target: MobileCallContextTarget; active: boolean; current: () => boolean; onBack: () => void; backLabel?: string;
  onOpenCase: (id: string) => void; onNewCase: (number: string) => void; onSelectNumber: (number: string) => void;
  wrapUp?: WrapUpDependencies;
}) {
  const state = useToolRequest<MobileCallContext>(active), { request } = state;
  const visit = useForegroundVisit(active, () => request.invalidate());
  const back = () => { if (visit.current()) onBack(); };
  const reload = () => { if (visit.current()) void request.run(signal => api.read(target, signal)); };
  useEffect(() => { if (active && visit.current()) void request.run(signal => api.read({ kind: target.kind, id: target.id }, signal)); }, [active, api, request, target.kind, target.id, visit]);
  useAndroidBack(active, back);
  useShellBack(active, backLabel, back);
  const data = active && current() ? state.data : null;
  const allowed = () => visit.current() && current() && request.snapshot().data === data && data !== null;
  const phone = data ? customerCallNumber(data.call.direction, data.call.number) : null;
  // A history reference is the call-log ID itself; a console session keeps the
  // call-log ID it resolved, so the section survives the card's own reloads.
  const [resolvedCallId, setResolvedCallId] = useState<string | null>(null);
  if (data?.call.id && data.call.id !== resolvedCallId) setResolvedCallId(data.call.id);
  const wrapUpCallId = target.kind === "call" ? target.id : resolvedCallId;
  const wrapUpAllowed = () => visit.current() && current();
  const title = data ? data.call.name || formatNumber(data.call.number) : "Detail hovoru";
  const direction = data ? data.call.direction === "internal" ? "Interný" : data.call.direction === "outbound" ? "Odchádzajúci" : "Prichádzajúci" : null;
  const duration = data?.call.durationSeconds != null ? Math.floor(data.call.durationSeconds / 60) + ":" + String(data.call.durationSeconds % 60).padStart(2, "0") : null;
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}
    refreshControl={<RefreshControl refreshing={state.busy} onRefresh={reload} />}>
    {!data && <Text accessibilityRole="header" style={s.heading}>Detail hovoru</Text>}
    {(state.busy || state.error || state.remaining > 0) && <View style={s.notices}>
      {state.busy && <Loading label="Načítavam údaje hovoru…" />}
      {state.error && <ErrorNotice message={state.error} onRetry={state.remaining ? undefined : reload} />}
      {state.remaining > 0 && <Text style={styles.muted}>Ďalší pokus o {state.remaining} s.</Text>}
    </View>}
    {data && <>
      <DetailHeader title={title} subtitle={data.call.name && data.call.number ? formatNumber(data.call.number) : null}
        meta={formatTime(data.call.startedAt) + " · overené " + formatTime(data.checkedAt)}
        trailing={data.call.number ? <CopyValue compact label="Skopírovať číslo hovoru" value={data.call.number}
          scopeKey={[data.profileId, data.organizationId, data.target.kind, data.target.id].join(":")} active={active && current()} /> : null}
        tags={<>
          <Tag text={direction!} tone={data.call.direction === "inbound" ? "blue" : "gray"} />
          <Tag text={callStatus(data.call.status)} tone={data.call.status === "missed" ? "red" : "gray"} />
          {data.linkedCase && <Tag text={data.linkedCase.caseNumber} tone="yellow" />}
        </>} />
      {phone && <ActionBar actions={[
        { icon: PhoneForwarded, label: "Vybrať číslo", accessibilityLabel: "Vybrať číslo na volanie", onPress: () => { if (allowed()) onSelectNumber(phone); } },
        { icon: FilePlus2, label: "Nový prípad", accessibilityLabel: "Použiť číslo v novom prípade", onPress: () => { if (allowed()) onNewCase(phone); } },
        ...(data.linkedCase ? [{ icon: FolderOpen, label: "Prípad", accessibilityLabel: "Otvoriť prípad hovoru", primary: true, onPress: () => { if (allowed() && data.linkedCase) onOpenCase(data.linkedCase.id); } }] : []),
      ]} />}
      {phone && <Text style={s.note}>Číslo pred uložením potvrdíte vo formulári. Vytvorenie prípadu samo nepriradí tento hovor{wrapUp && wrapUpCallId ? "; priradíte ho nižšie v časti Po hovore" : ""}.</Text>}
      <SectionHeader title="Hovor" />
      <Group>
        <InfoRow first label="Linka" value={data.call.lineLabel} />
        <InfoRow label="Dispečer" value={data.call.operatorName} />
        <InfoRow label="Prijatý" value={data.call.answeredAt ? formatTime(data.call.answeredAt) : null} empty="Neprijatý" />
        <InfoRow label="Ukončený" value={data.call.endedAt ? formatTime(data.call.endedAt) : null} empty="Ešte prebieha alebo nie je známy" />
        <InfoRow label="Dĺžka" value={duration} empty="Nie je známa" />
      </Group>
      <SectionHeader title="Prípad hovoru" />
      {data.linkedCase ? <Group><Row first title={data.linkedCase.caseNumber + " · " + data.linkedCase.statusLabel}
        subtitle={[data.linkedCase.contactName, data.linkedCase.licensePlate, data.linkedCase.ownerName ? "Dispečer: " + data.linkedCase.ownerName : null, data.linkedCase.summary || null].filter(Boolean).join(" · ")}
        accessibilityLabel="Otvoriť prípad hovoru" onPress={() => { if (allowed() && data.linkedCase) onOpenCase(data.linkedCase.id); }} trailing={<Text style={s.chevron}>›</Text>} /></Group>
        : <View style={s.notices}><Card><Text style={styles.text}>{data.linkState === "unavailable" ? "Priradenie prípadu sa nepodarilo overiť. Obnovte detail hovoru." : "Hovor zatiaľ nemá priradený prípad."}</Text>
          {data.linkState === "unavailable" && <Button label="Overiť priradenie prípadu" secondary onPress={reload} />}</Card></View>}
      {data.call.direction === "internal" && <Text style={s.note}>Interná linka sa nepoužíva ako telefón zákazníka.</Text>}
      {wrapUp && !data.call.id && <Text style={s.note}>Výsledok a priradenie k prípadu zapíšete, keď sa hovor objaví v histórii.</Text>}
    </>}
    {wrapUp && wrapUpCallId && <View style={s.wrapUp}><WrapUpSection key={wrapUpCallId} deps={wrapUp} callId={wrapUpCallId} active={active && current()} allowed={wrapUpAllowed} onLinked={reload} /></View>}
  </ScrollView>;
}
const s = StyleSheet.create({
  content: { paddingTop: 6, paddingBottom: NAVIGATION_CONTENT_BOTTOM },
  heading: { ...type.title, color: palette.label, paddingHorizontal: space.l },
  notices: { paddingHorizontal: space.l, paddingVertical: space.xs, gap: space.s },
  note: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 20, paddingTop: space.s },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
  wrapUp: { paddingHorizontal: space.l, paddingTop: space.l, gap: space.m },
});
