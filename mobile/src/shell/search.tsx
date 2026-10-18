import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Phone, Search, X } from "lucide-react-native";
import type { CasesApi } from "../cases/api";
import { Group, Row, SectionHeader } from "../design/list";
import { palette, space, type } from "../design/tokens";
import { MobileApiError, type MobileApi } from "../lib/api";
import { callStatus, formatNumber, formatTime } from "../lib/display";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import { moduleById, type ModuleId } from "./modules";
import { ModuleTile } from "./parts";

/** Organization-scoped search; absent until the workspace scope is verified. */
export type SearchScope = { cases: CasesApi; homeKey: readonly unknown[] };
type Props = {
  active: boolean; api: MobileApi; profileId: string; queryKey: readonly unknown[]; available: ModuleId[];
  scope: SearchScope | null; scopeNotice: string | null;
  onModule: (id: ModuleId) => void; onCase: (id: string) => void; onCall: (id: string) => void;
};
const LIMIT = 8;
const fold = (value: string) => value.toLocaleLowerCase("sk").normalize("NFD").replace(/[̀-ͯ]/g, "");
const errorText = (error: unknown) => error instanceof MobileApiError ? error.message : "Výsledky sa nepodarilo načítať.";
/** At least two characters, the same limits as the case and call searches. */
export function searchTerm(raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, " ").slice(0, 120);
  return value.length >= 2 ? value : null;
}

/** One field for cases (number, name, EČV, phone), calls and modules. */
export function SearchScreen({ active, api, profileId, queryKey, available, scope, scopeNotice, onModule, onCase, onCall }: Props) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState<string | null>(null);
  const field = useRef<TextInput>(null);
  useEffect(() => { const timer = setTimeout(() => setQ(searchTerm(input)), 300); return () => clearTimeout(timer); }, [input]);
  useEffect(() => { if (active) { const timer = setTimeout(() => field.current?.focus(), 250); return () => clearTimeout(timer); } }, [active]);
  const pending = searchTerm(input) !== q;
  const modules = q ? available.filter(id => fold(moduleById(id).name + " " + moduleById(id).description).includes(fold(q))) : [];
  const calls = useQuery({ queryKey: [...queryKey, "search", "calls", profileId, q], enabled: active && q !== null,
    queryFn: ({ signal }) => api.history(profileId, { category: "all", q: q! }, signal) });
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={s.content}>
    <Text accessibilityRole="header" style={s.title}>Hľadať</Text>
    <View style={s.field}>
      <Search size={16} color={palette.secondaryLabel} accessible={false} />
      <TextInput ref={field} accessibilityLabel="Hľadať prípad, EČV, telefón alebo modul" placeholder="Prípad, meno, EČV, telefón, modul" placeholderTextColor={palette.secondaryLabel}
        value={input} onChangeText={setInput} style={s.input} autoCorrect={false} autoCapitalize="none" returnKeyType="search" maxLength={120} />
      {input.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel="Vymazať hľadanie" hitSlop={10} onPress={() => setInput("")} style={s.clear}>
        <X size={13} strokeWidth={3} color="#FFFFFF" accessible={false} /></Pressable>}
    </View>
    {!q && !pending && <Text style={s.hint}>Zadajte aspoň 2 znaky. Hľadá sa v prípadoch celej organizácie (číslo, meno, EČV, telefón), v hovoroch a v moduloch.</Text>}
    {pending && <ActivityIndicator style={{ marginTop: space.l }} color={palette.secondaryLabel} />}
    {q && !pending && <>
      {modules.length > 0 && <><SectionHeader title="Moduly" />
        <Group>{modules.map((id, index) => <Row key={id} first={index === 0} title={moduleById(id).name} subtitle={moduleById(id).description}
          leading={<ModuleTile id={id} />} onPress={() => onModule(id)} trailing={<Text style={s.chevron}>›</Text>} />)}</Group></>}
      {scope ? <CaseResults active={active} scope={scope} q={q} onCase={onCase} />
        : <><SectionHeader title="Prípady" /><Text style={s.hint}>{scopeNotice ?? "Overujem prístup k prípadom…"}</Text></>}
      <SectionHeader title="Hovory" detail={calls.data ? countLabel(calls.data.calls.length, Boolean(calls.data.nextCursor)) : null} />
      {calls.isPending ? <ActivityIndicator color={palette.secondaryLabel} /> : calls.isError ? <Text style={[s.hint, { color: palette.redText }]}>{errorText(calls.error)}</Text>
        : calls.data.calls.length === 0 ? <Text style={s.hint}>Žiadne hovory.</Text>
          : <Group>{calls.data.calls.slice(0, LIMIT).map((call, index) => {
            const Icon = call.direction === "outbound" ? ArrowUpRight : call.direction === "internal" ? Phone : ArrowDownLeft, missed = call.status === "missed";
            return <Row key={call.id} first={index === 0} title={call.name || formatNumber(call.number)} accessibilityLabel={"Detail hovoru " + (call.name || formatNumber(call.number))}
              subtitle={[call.name ? formatNumber(call.number) : null, callStatus(call.status), formatTime(call.startedAt)].filter(Boolean).join(" · ")}
              leading={<View style={[s.rowIcon, missed && { backgroundColor: palette.redSoft }]}><Icon size={15} strokeWidth={2.2} color={missed ? palette.redText : palette.label} accessible={false} /></View>}
              onPress={() => onCall(call.id)} trailing={<Text style={s.chevron}>›</Text>} />;
          })}</Group>}
    </>}
  </ScrollView>;
}

function CaseResults({ active, scope, q, onCase }: { active: boolean; scope: SearchScope; q: string; onCase: (id: string) => void }) {
  const query = useQuery({ queryKey: [...scope.homeKey, "search-cases", q], enabled: active,
    queryFn: ({ signal }) => scope.cases.list({ ownership: "all", ownerId: null, category: "all", status: null, priority: null, q, cursor: null }, signal) });
  return <>
    <SectionHeader title="Prípady" detail={query.data ? countLabel(query.data.cases.length, Boolean(query.data.nextCursor)) : null} />
    {query.isPending ? <ActivityIndicator color={palette.secondaryLabel} /> : query.isError ? <Text style={[s.hint, { color: palette.redText }]}>{errorText(query.error)}</Text>
      : query.data.cases.length === 0 ? <Text style={s.hint}>Žiadne prípady.</Text>
        : <Group>{query.data.cases.slice(0, LIMIT).map((item, index) => <Row key={item.id} first={index === 0}
          title={[item.contact.name || "Kontakt bez mena", item.vehicle.licensePlate].filter(Boolean).join(" · ")} accessibilityLabel={"Otvoriť prípad " + item.caseNumber}
          subtitle={[item.caseNumber, item.statusLabel, item.priority === "urgent" ? item.priorityLabel : null, formatTime(item.createdAt)].filter(Boolean).join(" · ")}
          leading={<ModuleTile id="pripady" />} onPress={() => onCase(item.id)} trailing={<Text style={s.chevron}>›</Text>} />)}</Group>}
  </>;
}
function countLabel(count: number, more: boolean) { return more || count > LIMIT ? `${Math.min(count, LIMIT)} z ${count}${more ? "+" : ""}` : String(count); }

const s = StyleSheet.create({
  content: { paddingBottom: NAVIGATION_CONTENT_BOTTOM },
  title: { ...type.title, color: palette.label, paddingHorizontal: space.l, paddingTop: 2, paddingBottom: space.s },
  field: { marginHorizontal: space.l, minHeight: 40, borderRadius: 20, backgroundColor: palette.fill, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: space.m },
  input: { flex: 1, minHeight: 40, fontSize: 16, color: palette.label, paddingVertical: 0 },
  clear: { width: 18, height: 18, borderRadius: 9, backgroundColor: palette.tertiaryLabel, alignItems: "center", justifyContent: "center" },
  hint: { ...type.subhead, color: palette.secondaryLabel, paddingHorizontal: 20, paddingTop: space.s },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
  rowIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: palette.fill, alignItems: "center", justifyContent: "center" },
});
