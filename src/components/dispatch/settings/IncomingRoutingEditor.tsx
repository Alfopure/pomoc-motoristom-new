"use client";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DraftEditorState } from "../useDraftEditors";
import { ArrowRight, Library, Loader2, PhoneCall, Save, Undo2, Users } from "lucide-react";
import type { RoutingDocument } from "@/server/telephony/config-service";
import type { RoutingNavigationTarget } from "@/lib/telephony/routing-summary";
import { ConfigRequestError, loadRoutingConfig, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { FALLBACK_DESTINATION_ALLOWLIST, validateRingGroupDrafts, type GroupDraft } from "./ring-groups-model";
import { describeRingPlan, ringPlanIdsInUse, validateRingPlanDrafts, type PlanDraft } from "./ring-plan-model";
import { documentWithDraft, identifyGroups, identifyPlans, incomingDraft, incomingLineBehaviour, incomingMatches, incomingPayload, incomingPlanIdsForLine, incomingRouteSummary, initialIncomingLineId, mergeSavedLine } from "./incoming-routing-model";
import { RingGroupsEditor } from "./RingGroupsEditor";
import { RingPlanEditor } from "./RingPlanEditor";
import { LineInboundModeControl } from "./LineInboundModeControl";
import { SettingsIssueList, SettingsNotice, settingsInputClass } from "./settings-ui";

export type IncomingEditorActions = { save: () => Promise<boolean>; discard: () => void };
export function IncomingRoutingEditor({ document, canEdit, target, onSaved, onLineSaved, onNavigate, onDirtyChange, onActionsChange, onEditorStateChange }: {
  document: RoutingDocument; canEdit: boolean; target?: RoutingNavigationTarget | null;
  onSaved: (response: RoutingConfigResponse) => void;
  onLineSaved: (response: RoutingConfigResponse) => void;
  onNavigate: (target: RoutingNavigationTarget) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onActionsChange?: (actions: IncomingEditorActions | null) => void;
  onEditorStateChange?: (state: DraftEditorState | null) => void;
}) {
  const [baseline, setBaseline] = useState(document);
  const [draft, setDraft] = useState(() => incomingDraft(document));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [remote, setRemote] = useState<RoutingDocument | null>(null);
  const [lineId, setLineId] = useState(() => initialIncomingLineId(document, target));
  const [groupsOpen, setGroupsOpen] = useState(Boolean(target?.groupId) || document.groups.length === 0);
  const [focusPlanId, setFocusPlanId] = useState(target?.planId ?? null);
  const [previousTarget, setPreviousTarget] = useState(target);
  if (target !== previousTarget) {
    setPreviousTarget(target);
    if (target) { setLineId(initialIncomingLineId(baseline, target)); if (target.groupId) setGroupsOpen(true); }
    setFocusPlanId(target?.planId ?? null);
  }
  const working = useMemo(() => documentWithDraft(baseline, draft), [baseline, draft]);
  const dirty = !incomingMatches(draft, baseline);
  const pendingChanges = useRef(dirty || saving);
  useEffect(() => { pendingChanges.current = dirty || saving; }, [dirty, saving]);
  const issues = useMemo(() => [
    ...validateRingGroupDrafts(draft.groups, { operatorIds: working.operators.map(row => row.profileId), destinationAllowlist: working.limits?.destinationAllowlist ?? FALLBACK_DESTINATION_ALLOWLIST, plans: working.plans }),
    ...validateRingPlanDrafts(draft.plans, { groups: working.groups, destinationAllowlist: working.limits?.destinationAllowlist ?? FALLBACK_DESTINATION_ALLOWLIST, planIdsInUse: ringPlanIdsInUse(working.lines, working.ivrMenus), maxRingFanout: working.limits?.maxRingFanout }),
  ], [draft, working]);
  const setGroups: Dispatch<SetStateAction<GroupDraft[]>> = change => setDraft(current => ({ ...current, groups: identifyGroups(typeof change === "function" ? change(current.groups) : change) }));
  const setPlans: Dispatch<SetStateAction<PlanDraft[]>> = change => setDraft(current => ({ ...current, plans: identifyPlans(typeof change === "function" ? change(current.plans) : change) }));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const line = working.lines.find(row => row.id === lineId);
  const effectiveLine = line?.returnLineId ? working.lines.find(row => row.id === line.returnLineId) : line;
  const visiblePlanIds = incomingPlanIdsForLine(working, lineId);
  const defaultMode = baseline.capabilities?.defaultInboundCallMode ?? baseline.settings?.inboundCallMode ?? null;
  const behaviour = incomingLineBehaviour(line, defaultMode);
  const manualQueue = Boolean(line && behaviour.mode === "queue_first");
  const unknownMode = Boolean(line && behaviour.mode === null);
  const routeSummary = incomingRouteSummary(working, lineId);
  const activeRoute = Boolean(line?.active && effectiveLine?.active);
  const activeIvr = working.ivrMenus.some(menu => menu.id === effectiveLine?.ivrMenuId && menu.active);
  const activeHours = working.businessHours.some(hours => hours.id === effectiveLine?.businessHoursId && hours.active);
  function showLibrary() { setLineId(""); setFocusPlanId(null); }
  function revealPlan(planId: string) { setLineId(""); setFocusPlanId(planId); }
  function revealIssues() { showLibrary(); setGroupsOpen(true); }
  function accept(response: RoutingConfigResponse) {
    pendingChanges.current = false;
    setBaseline(response.document); setDraft(incomingDraft(response.document)); setRemote(null); setUncertain(false); onSaved(response);
  }
  function acceptLineMode(response: RoutingConfigResponse) {
    // This PATCH saves one number independently. Keep unsaved group/plan drafts
    // and their original comparison baseline intact.
    setBaseline(current => mergeSavedLine(current, response.document));
    onLineSaved(response);
  }
  function discard() { pendingChanges.current = false; setDraft(incomingDraft(remote ?? baseline)); if (remote) setBaseline(remote); setRemote(null); setUncertain(false); setError(null); }
  async function verify(): Promise<boolean> {
    try {
      const latest = await loadRoutingConfig("incoming");
      if (incomingMatches(draft, latest.document)) {
        accept(latest); setError(null); setNotice("Uložený stav je overený. Skupiny aj plány zodpovedajú tvojim zmenám."); return true;
      }
      setRemote(latest.document); setUncertain(false);
      setError("Uložený stav sa líši. Tvoje zmeny zostávajú v návrhu. Porovnaj ich pred ďalším uložením.");
    } catch { setUncertain(true); setError("Výsledok uloženia zatiaľ nemožno overiť. Návrh zostáva zachovaný; neukladaj ho opakovane naslepo."); }
    return false;
  }
  async function save(): Promise<boolean> {
    if (!canEdit || saving || uncertain || issues.length > 0 || remote) return false;
    if (!dirty) return true;
    let accepted = false;
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await saveRoutingConfig("incoming", { ...incomingPayload(draft), version: baseline.routingVersion });
      accept(response); accepted = true; setNotice(`Skupiny aj plány sú uložené spolu. Nové smerovanie platí pre nové hovory.${response.warning ? ` ${response.warning}` : ""}`); return true;
    } catch (caught) {
      if (caught instanceof ConfigRequestError && caught.status >= 400 && caught.status < 500) {
        setError(caught.message);
        if (caught.status === 409) {
          try { const latest = await loadRoutingConfig("incoming"); setRemote(latest.document); } catch { setUncertain(true); }
        }
        return false;
      }
      setUncertain(true);
      accepted = await verify();
      return accepted;
    } finally { pendingChanges.current = !accepted && dirty; setSaving(false); }
  }
  useEffect(() => { onEditorStateChange?.({ dirty, saving, save, discard, hasPendingChanges: () => pendingChanges.current }); });
  useEffect(() => () => onEditorStateChange?.(null), [onEditorStateChange]);
  // The parent owns only navigation; this component remains the sole draft owner.
  useEffect(() => { onActionsChange?.({ save, discard }); return () => onActionsChange?.(null); });
  return <section className="grid min-w-0 gap-3 [&_label>span]:font-medium [&_label>span]:normal-case" aria-label="Prichádzajúce hovory">
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-[0_1px_3px_rgba(20,30,50,0.04)]">
      <h2 className="text-base font-semibold text-zinc-900">Prichádzajúce hovory</h2>
      <p className="mt-1 text-sm text-zinc-600">Vyber číslo a nastav cestu hovoru. Zmeny členov a plánov zostávajú v návrhu, kým ich neuložíš.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 gap-1 text-xs font-medium text-zinc-600">Linka<select className={settingsInputClass} value={lineId} onChange={event => { const chosen = working.lines.find(row => row.id === event.target.value); const effective = chosen?.returnLineId ? working.lines.find(row => row.id === chosen.returnLineId) : chosen; setLineId(event.target.value); setFocusPlanId(effective?.ringPlanId ?? null); }}><option value="">Všetky plány vrátane nepoužitých</option>{working.lines.map(row => <option key={row.id} value={row.id}>{row.label} · {row.phoneNumber}{row.active ? "" : " (neaktívna)"}</option>)}</select></label>
        {line && <button type="button" onClick={showLibrary} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium"><Library size={15} aria-hidden="true" />Všetky plány</button>}
        {line && <button type="button" className="min-h-10 rounded-lg border border-zinc-200 px-3 text-sm font-medium" onClick={() => onNavigate({ section: "telephony", tab: "numbers", lineId: line.id })}>Priradenie linky</button>}
        {effectiveLine?.businessHoursId && <button type="button" className="min-h-10 rounded-lg border border-zinc-200 px-3 text-sm font-medium" onClick={() => onNavigate({ section: "telephony", tab: "hours", lineId: effectiveLine.id, businessHoursId: effectiveLine.businessHoursId! })}>Otváracie hodiny</button>}
        {effectiveLine?.ivrMenuId && <button type="button" className="min-h-10 rounded-lg border border-zinc-200 px-3 text-sm font-medium" onClick={() => onNavigate({ section: "telephony", tab: "ivr", lineId: effectiveLine.id, ivrMenuId: effectiveLine.ivrMenuId! })}>Hlasové menu</button>}
      </div>
      {line && <ol aria-label="Cesta hovoru" className="mt-4 grid gap-3 rounded-lg border border-zinc-100 bg-zinc-50 p-3 sm:grid-cols-3">
        {[
          { label: "Číslo", text: `${line.phoneNumber}${line.active ? "" : " · neaktívne"}`, icon: PhoneCall },
          { label: manualQueue ? "Čakáreň" : "Komu zvoní", text: !activeRoute ? routeSummary.ring : manualQueue ? "Bez automatického zvonenia" : unknownMode ? "Podľa predvoľby organizácie" : routeSummary.ring, icon: Users },
          { label: manualQueue ? "Prevzatie hovoru" : "Keď nikto nezdvihne", text: !activeRoute ? routeSummary.fallback : manualQueue ? "Ručne v aplikácii" : unknownMode ? "Podľa predvoľby organizácie" : routeSummary.fallback, icon: ArrowRight },
        ].map((item, index) => <li key={item.label} className="flex min-w-0 items-start gap-2"><item.icon size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-zinc-500" /><div className="min-w-0"><span className="text-xs font-medium text-zinc-500">{index + 1}. {item.label}</span><p className="mt-1 text-sm text-zinc-800">{item.text}</p></div></li>)}
      </ol>}
      {line && (activeHours || activeIvr) && <p className="mt-2 text-xs text-zinc-500">Pred zvonením sa uplatnia {activeHours ? "otváracie hodiny" : ""}{activeHours && activeIvr ? " a " : ""}{activeIvr ? "voľba v hlasovom menu" : ""}.{activeIvr ? " Nižšie sú aj plány dostupné cez IVR." : ""}</p>}
      {line && <LineInboundModeControl key={line.id} line={line} defaultMode={defaultMode} canEdit={canEdit} onSaved={acceptLineMode} />}
      {line?.returnLineId && <p className="mt-2 text-xs text-zinc-600">Návratové číslo používa smerovanie linky {effectiveLine?.label ?? "(nedostupná)"}.</p>}
      {target?.planId && !working.plans.some(plan => plan.id === target.planId) && <SettingsNotice tone="warning">Vybraný plán už neexistuje alebo k nemu nemáš prístup. Zobrazuje sa dostupná konfigurácia.</SettingsNotice>}
    </div>
    {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
    {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
    {uncertain && <button type="button" disabled={saving} onClick={() => void verify()} className="justify-self-start rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold">Overiť uložený stav</button>}
    {remote && <details open className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm"><summary className="cursor-pointer font-semibold">Konflikt: porovnať uloženú konfiguráciu a vlastný návrh</summary><div className="mt-2 grid gap-3 md:grid-cols-2">{[{ title: "Aktuálne uložené", document: remote }, { title: "Tvoj zachovaný návrh", document: working }].map(entry => <div key={entry.title}><h3 className="font-semibold">{entry.title}</h3>{entry.document.plans.map(plan => <p className="mt-2" key={plan.id}><strong>{plan.name}:</strong> {describeRingPlan(incomingDraft(entry.document).plans.find(row => row.id === plan.id)!, entry.document.groups, entry.document.limits?.maxRingFanout)}</p>)}{entry.document.groups.map(group => <p key={group.id} className="mt-1 text-xs">{group.name}: {group.members.map(member => member.memberKind === "operator" ? entry.document.operators.find(operator => operator.profileId === member.profileId)?.displayName ?? "Operátor" : member.externalNumber).join(", ") || "bez členov"}</p>)}</div>)}</div><p className="mt-3 text-xs">Pre bezpečnú novú úpravu načítaj uložený stav. Vlastné hodnoty si najprv môžeš skopírovať z návrhu.</p><button type="button" onClick={discard} className="mt-2 min-h-10 rounded-lg border border-amber-300 bg-white px-3 font-semibold">Zahodiť návrh a načítať uložené</button></details>}
    {manualQueue || unknownMode ? <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="font-semibold text-zinc-900">{manualQueue ? "Hovor čaká na ručné prevzatie" : "Predvolený režim nie je dostupný"}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-600">{manualQueue ? "Operátor si hovor vyberie v čakárni a prevezme ho cez pripojený telefón v aplikácii. Automatické kroky ani nastavenie „Keď nikto nezdvihne“ sa v tomto režime nepoužijú." : "Účinné zvonenie nemožno určiť bez predvoľby organizácie. Uložené plány môžeš prezerať v knižnici."}</p>
      <button type="button" onClick={showLibrary} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium"><Library size={15} aria-hidden="true" />Upraviť plány v knižnici</button>
    </div> : <>
      {!line && <p className="px-1 text-sm text-zinc-600">Knižnica obsahuje všetky plány vrátane nepoužitých. Úprava zdieľaného plánu sa prejaví na všetkých linkách, ktoré ho používajú.</p>}
      <RingPlanEditor canEdit={canEdit && !saving} document={working} controlled={{ plans: draft.plans, onChange: setPlans }} visiblePlanIds={visiblePlanIds} strategyOverride={line ? behaviour.strategyOverride : null} onAddPlan={showLibrary} focusPlanId={focusPlanId} focusGroupId={target?.groupId} onSaved={onSaved} onNavigateToIvr={() => onNavigate({ section: "telephony", tab: "ivr" })} onNavigateToNumbers={() => onNavigate({ section: "telephony", tab: "numbers" })} renderGroupEditor={(groupId, context) => <RingGroupsEditor canEdit={canEdit && !saving} document={working} controlled={{ groups: draft.groups, onChange: setGroups }} onlyGroupId={groupId} timingContext={context} onSaved={onSaved} onNavigateToPlan={revealPlan} />} />
    </>}
    <details className="rounded-xl border border-zinc-200 bg-white" open={groupsOpen} onToggle={event => setGroupsOpen(event.currentTarget.open)}><summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Knižnica skupín ({draft.groups.length}) · pridať skupinu a upraviť nepoužité</summary><RingGroupsEditor canEdit={canEdit && !saving} document={working} controlled={{ groups: draft.groups, onChange: setGroups }} onSaved={onSaved} onNavigateToPlan={revealPlan} /></details>
    <div className={`${dirty ? "sticky bottom-0 z-10 shadow-[0_-2px_10px_rgba(20,30,50,0.05)]" : ""} rounded-xl border border-zinc-200 bg-white p-3`}>
      <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={!canEdit || !dirty || saving || uncertain || Boolean(remote) || issues.length > 0} onClick={() => void save()} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#FCD703] px-4 text-sm font-semibold text-zinc-950 disabled:opacity-40">{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}Uložiť všetky zmeny</button><button type="button" disabled={!dirty || saving} onClick={() => { if (window.confirm("Zahodiť všetky neuložené zmeny skupín a plánov?")) discard(); }} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium disabled:opacity-40"><Undo2 size={15} />Zahodiť</button><span role="status" className="text-xs text-zinc-600">{dirty ? "Neuložené zmeny skupín a plánov" : "Všetky zmeny sú uložené"}</span></div>
      {issues.length > 0 && <div className="mt-2"><SettingsIssueList issues={issues} /><button type="button" onClick={revealIssues} className="mt-2 min-h-9 rounded-md border border-zinc-200 px-3 text-xs font-semibold">Zobraziť všetky plány a chyby</button></div>}
    </div>
  </section>;
}
