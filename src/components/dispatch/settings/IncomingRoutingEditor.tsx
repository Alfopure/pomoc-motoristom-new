"use client";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DraftEditorState } from "../useDraftEditors";
import { ArrowDown, Check, Clock3, Library, Loader2, PhoneIncoming, Save, Settings2, Undo2 } from "lucide-react";
import type { RoutingDocument } from "@/server/telephony/config-service";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { RoutingNavigationTarget } from "@/lib/telephony/routing-summary";
import { ConfigRequestError, loadRoutingConfig, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { FALLBACK_DESTINATION_ALLOWLIST, validateRingGroupDrafts, type GroupDraft } from "./ring-groups-model";
import { describeRingPlan, ringPlanIdsInUse, validateRingPlanDrafts, type PlanDraft } from "./ring-plan-model";
import { documentWithDraft, identifyGroups, identifyPlans, incomingDraft, incomingAffectedLines, incomingModeName, updateIncomingLineMode, incomingLineBehaviour, incomingMatches, incomingPayload, incomingPlanIdsForLine, initialIncomingLineId } from "./incoming-routing-model";
import { RingGroupsEditor } from "./RingGroupsEditor";
import { RingPlanEditor } from "./RingPlanEditor";
import { LineInboundModeControl } from "./LineInboundModeControl";
import type { DetachedPersonDevices } from "./ring-people-model";
import { SettingsIssueList, SettingsNotice, settingsInputClass } from "./settings-ui";

export type IncomingEditorActions = { save: () => Promise<boolean>; discard: () => void };
export function IncomingRoutingEditor({ document, canEdit, target, onSaved, onNavigate, onDirtyChange, onActionsChange, onEditorStateChange }: {
  document: RoutingDocument; canEdit: boolean; target?: RoutingNavigationTarget | null;
  onSaved: (response: RoutingConfigResponse) => void;
  onNavigate: (target: RoutingNavigationTarget) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onActionsChange?: (actions: IncomingEditorActions | null) => void;
  onEditorStateChange?: (state: DraftEditorState | null) => void;
}) {
  const [baseline, setBaseline] = useState(document);
  const [draft, setDraft] = useState(() => incomingDraft(document));
  const [detachedDevices, setDetachedDevices] = useState<DetachedPersonDevices>(() => new Map());
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
  const affectedLines = useMemo(() => incomingAffectedLines(baseline, draft), [baseline, draft]);
  const atomicModes = baseline.capabilities?.atomicIncomingLineModes === true;
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
  const activeRoute = Boolean(line?.active && effectiveLine?.active);
  const activeIvr = working.ivrMenus.some(menu => menu.id === effectiveLine?.ivrMenuId && menu.active);
  const activeHours = working.businessHours.some(hours => hours.id === effectiveLine?.businessHoursId && hours.active);
  function showLibrary() { setLineId(""); setFocusPlanId(null); }
  function revealPlan(planId: string) { setLineId(""); setFocusPlanId(planId); }
  function revealIssues() { showLibrary(); setGroupsOpen(true); }
  function accept(response: RoutingConfigResponse) {
    setDetachedDevices(new Map());
    pendingChanges.current = false;
    setBaseline(response.document); setDraft(incomingDraft(response.document)); setRemote(null); setUncertain(false); onSaved(response);
  }
  function discard() { pendingChanges.current = false; setDetachedDevices(new Map()); setDraft(incomingDraft(remote ?? baseline)); if (remote) setBaseline(remote); setRemote(null); setUncertain(false); setError(null); setNotice(null); }
  async function verify(): Promise<boolean> {
    try {
      const latest = await loadRoutingConfig("incoming");
      if (incomingMatches(draft, latest.document)) {
        accept(latest); setError(null); setNotice("Uložený stav je overený. Režimy liniek, skupiny aj plány zodpovedajú tvojim zmenám."); return true;
      }
      setRemote(latest.document); setUncertain(false);
      setError("Uložený stav sa líši. Tvoje zmeny zostávajú v návrhu. Porovnaj ich pred ďalším uložením.");
    } catch { setUncertain(true); setError("Výsledok uloženia zatiaľ nemožno overiť. Návrh zostáva zachovaný; neukladaj ho opakovane naslepo."); }
    return false;
  }
  async function verifySavedState() {
    if (saving) return;
    setSaving(true);
    try { await verify(); } finally { setSaving(false); }
  }
  async function save(): Promise<boolean> {
    if (!canEdit || saving || uncertain || issues.length > 0 || remote) return false;
    if (!dirty) return true;
    let accepted = false;
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await saveRoutingConfig("incoming", { ...incomingPayload(draft), version: baseline.routingVersion });
      accept(response); accepted = true; setNotice(`Všetky zmeny sú uložené spolu. Nové smerovanie platí pre nové hovory.${response.warning ? ` ${response.warning}` : ""}`); return true;
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
  return <section className="grid min-w-0 gap-2 [&_label>span]:font-medium [&_label>span]:normal-case" aria-label="Prichádzajúce hovory">
    <header className="flex flex-wrap items-start justify-between gap-3 px-1 pt-1">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-950">{line ? "Cesta prichádzajúceho hovoru" : "Knižnica plánov"}</h2>
        <p className="mt-1 text-sm text-zinc-500">{line ? "Kto hovor prijme a čo sa stane, ak nezdvihne." : "Všetky postupy zvonenia na jednom mieste."}</p>
      </div>
      {line && <button type="button" onClick={showLibrary} className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-zinc-600 hover:bg-white hover:text-zinc-950"><Library size={16} aria-hidden="true" />Všetky plány</button>}
    </header>
    <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-zinc-900 text-white"><PhoneIncoming size={22} aria-hidden="true" /></span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">{line ? "Volajúci vytočí" : "Nastavenie pre linku"}</p>
            <p className="mt-0.5 break-words text-xl font-semibold tracking-tight text-zinc-950 sm:text-2xl">{line ? formatPhoneNumberForDisplay(line.phoneNumber) : "Všetky linky"}</p>
            {line && <p className="mt-1 text-sm text-zinc-500">{line.label}{!activeRoute && <span className="ml-2 rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">Smerovanie nie je aktívne</span>}</p>}
          </div>
        </div>
        <label className="grid w-full min-w-0 gap-1 text-xs text-zinc-500 sm:w-auto sm:max-w-[260px]">{line ? "Zmeniť linku" : "Vybrať linku"}
          <select aria-label="Linka" className={settingsInputClass} value={lineId} onChange={event => { setLineId(event.target.value); setFocusPlanId(null); }}>
            <option value="">Všetky plány vrátane nepoužitých</option>
            {working.lines.map(row => <option key={row.id} value={row.id}>{row.label} · {row.phoneNumber}{row.active ? "" : " (neaktívna)"}</option>)}
          </select>
        </label>
      </div>
      {line && <LineInboundModeControl key={line.id} line={line} defaultMode={defaultMode} canEdit={canEdit && !saving && !uncertain && !remote} available={atomicModes} onChange={mode => setDraft(current => updateIncomingLineMode(current, baseline, line.id, mode))}>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-100 pt-2 text-xs text-zinc-500">
        <button type="button" className="inline-flex min-h-8 items-center gap-1.5 hover:text-zinc-950" onClick={() => onNavigate({ section: "telephony", tab: "numbers", lineId: line.id })}><Settings2 size={13} aria-hidden="true" />Priradenie linky</button>
        {effectiveLine?.businessHoursId && <button type="button" className="inline-flex min-h-8 items-center gap-1.5 hover:text-zinc-950" onClick={() => onNavigate({ section: "telephony", tab: "hours", lineId: effectiveLine.id, businessHoursId: effectiveLine.businessHoursId! })}><Clock3 size={13} aria-hidden="true" />Otváracie hodiny</button>}
        {effectiveLine?.ivrMenuId && <button type="button" className="min-h-8 hover:text-zinc-950" onClick={() => onNavigate({ section: "telephony", tab: "ivr", lineId: effectiveLine.id, ivrMenuId: effectiveLine.ivrMenuId! })}>Hlasové menu</button>}
        </div>
      </LineInboundModeControl>}
      {line && (activeHours || activeIvr) && <p className="mt-2 text-xs leading-5 text-zinc-500">Najprv sa uplatnia {activeHours ? "otváracie hodiny" : ""}{activeHours && activeIvr ? " a " : ""}{activeIvr ? "voľba v hlasovom menu" : ""}.{activeIvr ? " Plány nižšie patria jednotlivým vetvám menu." : ""}</p>}
      {line?.returnLineId && <p className="mt-2 text-xs text-zinc-500">Návratové číslo používa smerovanie linky {effectiveLine?.label ?? "(nedostupná)"}.</p>}
      {target?.planId && !working.plans.some(plan => plan.id === target.planId) && <SettingsNotice tone="warning">Vybraný plán už neexistuje alebo k nemu nemáš prístup. Zobrazuje sa dostupná konfigurácia.</SettingsNotice>}
    </div>
    {line && <div className="-my-2 flex items-center gap-2 pl-5 text-xs text-zinc-400 sm:pl-7" aria-hidden="true"><ArrowDown size={17} /><span>{!activeRoute ? "Uložený postup pre neaktívnu linku" : manualQueue ? "Hovor čaká na operátora" : "Hovor pokračuje podľa tohto postupu"}</span></div>}
    {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
    {notice && !dirty && <SettingsNotice tone="success">{notice}</SettingsNotice>}
    {uncertain && <button type="button" disabled={saving} onClick={() => void verifySavedState()} className="justify-self-start rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold">Overiť uložený stav</button>}
    {remote && <details open className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm"><summary className="cursor-pointer font-semibold">Konflikt: porovnať uloženú konfiguráciu a vlastný návrh</summary><div className="mt-2 grid gap-3 md:grid-cols-2">{[{ title: "Aktuálne uložené", document: remote }, { title: "Tvoj zachovaný návrh", document: working }].map(entry => <div key={entry.title}><h3 className="font-semibold">{entry.title}</h3>{(draft.lineModes ?? []).map(change => { const compared = entry.document.lines.find(row => row.id === change.id); return <p className="mt-2 text-sm" key={change.id}><strong>{compared?.label ?? "Odstránená linka"}:</strong> {compared ? incomingModeName(compared.inboundCallMode) : "Linka už nie je dostupná"}</p>; })}{entry.document.plans.map(plan => <p className="mt-2" key={plan.id}><strong>{plan.name}:</strong> {describeRingPlan(incomingDraft(entry.document).plans.find(row => row.id === plan.id)!, entry.document.groups, entry.document.limits?.maxRingFanout)}</p>)}{entry.document.groups.map(group => <p key={group.id} className="mt-1 text-xs">{group.name}: {group.members.map(member => member.memberKind === "operator" ? entry.document.operators.find(operator => operator.profileId === member.profileId)?.displayName ?? "Operátor" : member.externalNumber).join(", ") || "bez členov"}</p>)}</div>)}</div><p className="mt-3 text-xs">Pre bezpečnú novú úpravu načítaj uložený stav. Vlastné hodnoty si najprv môžeš skopírovať z návrhu.</p><button type="button" onClick={discard} className="mt-2 min-h-10 rounded-lg border border-amber-300 bg-white px-3 font-semibold">Zahodiť návrh a načítať uložené</button></details>}
    {manualQueue || unknownMode ? <div className="rounded-2xl border border-zinc-200 bg-white p-6">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-yellow-50 text-zinc-800"><Clock3 size={24} aria-hidden="true" /></div>
      <h3 className="font-semibold text-zinc-900">{manualQueue ? "Hovor čaká na ručné prevzatie" : "Predvolený režim nie je dostupný"}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-600">{manualQueue ? "Operátor si hovor vyberie v čakárni a prevezme ho cez pripojený telefón v aplikácii. Automatické kroky ani nastavenie „Keď nikto nezdvihne“ sa v tomto režime nepoužijú." : "Účinné zvonenie nemožno určiť bez predvoľby organizácie. Uložené plány môžeš prezerať v knižnici."}</p>
      <button type="button" onClick={showLibrary} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium"><Library size={15} aria-hidden="true" />Upraviť plány v knižnici</button>
    </div> : <>
      {!line && <p className="px-1 text-sm text-zinc-600">Knižnica obsahuje všetky plány vrátane nepoužitých. Úprava zdieľaného plánu sa prejaví na všetkých linkách, ktoré ho používajú.</p>}
      <RingPlanEditor canEdit={canEdit && !saving} document={working} controlled={{ plans: draft.plans, onChange: setPlans }} visiblePlanIds={visiblePlanIds} strategyOverride={line ? behaviour.strategyOverride : null} onAddPlan={showLibrary} focusPlanId={focusPlanId} focusGroupId={target?.groupId} onSaved={onSaved} onNavigateToIvr={() => onNavigate({ section: "telephony", tab: "ivr" })} onNavigateToNumbers={() => onNavigate({ section: "telephony", tab: "numbers" })} renderGroupEditor={(groupId, context) => <RingGroupsEditor detachedDevices={{ devices: detachedDevices, onChange: setDetachedDevices }} canEdit={canEdit && !saving} document={working} controlled={{ groups: draft.groups, onChange: setGroups }} onlyGroupId={groupId} timingContext={context} groupSelector={context.groupSelector} onSaved={onSaved} onNavigateToPlan={revealPlan} />} />
    </>}
    <details className="border-t border-zinc-200" open={groupsOpen} onToggle={event => setGroupsOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer px-1 py-2 text-xs font-medium text-zinc-500">Knižnica skupín ({draft.groups.length}) · správa zdieľaných zoznamov</summary>
      <RingGroupsEditor detachedDevices={{ devices: detachedDevices, onChange: setDetachedDevices }} canEdit={canEdit && !saving} document={working} controlled={{ groups: draft.groups, onChange: setGroups }} onSaved={onSaved} onNavigateToPlan={revealPlan} />
    </details>
    <div className={`${dirty ? "sticky bottom-0 z-10 shadow-[0_-4px_20px_rgba(20,30,50,0.05)]" : ""} rounded-xl border border-zinc-200 bg-white px-4 py-2.5 sm:px-5`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="status" className="flex items-center gap-2 text-sm text-zinc-600">{dirty ? <span className="h-2 w-2 rounded-full bg-amber-400" /> : <Check size={16} className="text-zinc-400" aria-hidden="true" />}{dirty ? "Neuložené zmeny" : "Všetky zmeny sú uložené"}</div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!dirty || saving} onClick={() => { if (window.confirm("Zahodiť všetky neuložené zmeny vrátane režimov liniek?")) discard(); }} className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-zinc-500 hover:bg-zinc-50 disabled:opacity-40"><Undo2 size={15} aria-hidden="true" />Zahodiť</button>
          <button type="button" disabled={!canEdit || !dirty || saving || uncertain || Boolean(remote) || issues.length > 0} onClick={() => void save()} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#FCD703] px-4 text-sm font-semibold text-zinc-950 disabled:opacity-40">{saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}Uložiť všetky zmeny</button>
        </div>
      </div>
      {dirty && <p className="mt-2 text-xs leading-5 text-zinc-500">{affectedLines.length > 0 ? `Dotknuté linky: ${affectedLines.map(row => `${row.label} (${formatPhoneNumberForDisplay(row.phoneNumber)})`).join(", ")}.` : "Zmeny sa týkajú skupín alebo plánov bez priradenej linky."} Zmeny sa prejavia až po uložení, pre nové hovory.</p>}
      {issues.length > 0 && <div className="mt-2"><SettingsIssueList issues={issues} /><button type="button" onClick={revealIssues} className="mt-2 min-h-9 rounded-md border border-zinc-200 px-3 text-xs font-semibold">Zobraziť všetky plány a chyby</button></div>}
    </div>
  </section>;
}
