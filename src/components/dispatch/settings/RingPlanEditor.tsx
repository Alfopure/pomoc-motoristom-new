"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, Clock3, GripVertical, ListOrdered, Loader2, PhoneForwarded, PhoneOff, PhoneOutgoing, Plus, Save, Trash2, Users, type LucideIcon } from "lucide-react";

import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

import { ConfigRequestError, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { FALLBACK_DESTINATION_ALLOWLIST, issuesByPath } from "./ring-groups-model";
import {
  FALLBACK_ORDER,
  MAX_TIMEOUT_SECS,
  MIN_TIMEOUT_SECS,
  STRATEGY_LABELS,
  addPlan,
  addStep,
  describeRingPlan,
  moveStepInPlans,
  planDraftsFromDocument,
  planUsageNote,
  referencesUsingPlan,
  removePlan,
  removeStep,
  ringPlanIdsInUse,
  ringPlanSeconds,
  ringPlansDirty,
  ringPlansPayload,
  stepTiming,
  updatePlan,
  updateStep,
  validateRingPlanDrafts,
  type PlanDraft,
} from "./ring-plan-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";
import { SortableList } from "./sortable-list";
import { PhoneNumberHint, PhoneNumberInput } from "../PhoneNumberInput";

const FALLBACK_HELP: Record<PlanDraft["fallbackKind"], string> = {
  waiting_room: "Volajúci zostane v čakárni. Systém bude hovor znovu ponúkať dostupným operátorom v aplikácii; prevziať ho možno aj ručne.",
  external_number: "Číslo sa vytočí raz. Pri neprijatí nasleduje ponuka spätného volania, ak je číslo volajúceho známe.",
  callback_prompt: "Volajúci môže požiadať o spätné volanie, ak je jeho telefónne číslo známe.",
  hangup_message: "Prehrá sa záverečná hláška a hovor sa ukončí.",
};

const FALLBACK_CHOICES: Record<PlanDraft["fallbackKind"], { label: string; hint: string; icon: LucideIcon }> = {
  callback_prompt: { label: "Spätné volanie", hint: "Ponúknuť zavolanie späť", icon: PhoneOutgoing },
  waiting_room: { label: "Čakáreň", hint: "Znovu ponúkať operátorom", icon: Clock3 },
  external_number: { label: "Iné číslo", hint: "Presmerovať jedenkrát", icon: PhoneForwarded },
  hangup_message: { label: "Ukončiť hovor", hint: "Prehrať záverečnú hlášku", icon: PhoneOff },
};

/** Flat timeline presentation; SortableList retains pointer and keyboard ordering. */
function RingingStep({ children, id, index, planName, disabled, onRemove }: {
  children: ReactNode;
  id: string;
  index: number;
  planName: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id, disabled });

  return <div
    ref={setNodeRef}
    style={{ transform: CSS.Transform.toString(transform), transition }}
    className={`relative pb-4 ${isDragging ? "z-10 rounded-lg bg-white shadow-lg ring-1 ring-zinc-200" : ""}`}
  >
    <span className="absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-full border border-zinc-200 bg-white text-xs font-semibold tabular-nums text-zinc-600">{index + 1}</span>
    <div className="min-w-0 pl-9 sm:pl-11">
      <div className="mb-2 flex min-h-9 items-center justify-between gap-2">
        <h5 className="text-base font-semibold tracking-tight text-zinc-950">{index === 0 ? "Komu zvoní" : "Ďalší pokus"}</h5>
        <div className="flex items-center gap-1">
          <button type="button" disabled={disabled} aria-label={`Presunúť ${index + 1}. krok plánu ${planName}`} title="Zmeniť poradie krokov"
            className="inline-flex h-8 w-8 cursor-grab items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:cursor-default disabled:opacity-40"
            {...attributes} {...listeners}>
            <GripVertical size={16} aria-hidden="true" />
          </button>
          <button type="button" disabled={disabled} onClick={onRemove} aria-label={`Odobrať ${index + 1}. krok plánu ${planName}`} title="Odobrať krok"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-40">
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      {children}
    </div>
  </div>;
}

/**
 * Ring plan screen (plan "Fáza 3"): the ordered steps a call walks through and
 * what happens when they are exhausted. Every decision lives in
 * `ring-plan-model.ts`, including the plain-language preview above each plan.
 *
 * Saving a plan never disturbs a call in progress: the plan is frozen into the
 * session when the call starts.
 */
export function RingPlanEditor({
  canEdit,
  document,
  focusPlanId,
  focusGroupId,
  onNavigateToIvr,
  onNavigateToNumbers,
  onSaved,
  controlled,
  renderGroupEditor,
  visiblePlanIds,
  onAddPlan,
  strategyOverride,
}: {
  controlled?: { plans: PlanDraft[]; onChange: Dispatch<SetStateAction<PlanDraft[]>> };
  renderGroupEditor?: (groupId: string, context: { strategy: "all" | "ordered"; timeoutSecs: number; planId: string | null; groupSelector?: ReactNode }) => ReactNode;
  /** Filters rendering only; state, validation and saving retain every plan. */
  visiblePlanIds?: readonly string[] | null;
  onAddPlan?: () => void;
  strategyOverride?: "all" | "ordered" | null;
  canEdit: boolean;
  document: RoutingDocument;
  focusPlanId?: string | null;
  focusGroupId?: string | null;
  onNavigateToIvr?: () => void;
  onNavigateToNumbers?: () => void;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const [localPlans, setLocalPlans] = useState<PlanDraft[]>(() => planDraftsFromDocument(document.plans));
  const plans = controlled?.plans ?? localPlans;
  const setPlans = controlled?.onChange ?? setLocalPlans;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const operatorNames = useMemo(
    () => new Map(document.operators.map((operator) => [operator.profileId, operator.displayName])),
    [document.operators],
  );

  const scopeKey = visiblePlanIds?.join(",") ?? "all";
  useEffect(() => {
    if (!focusPlanId) return;
    const frame = window.requestAnimationFrame(() => {
      const element = window.document.getElementById(`ring-plan-${focusPlanId}`);
      element?.scrollIntoView({ behavior: "smooth", block: "start" });
      element?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusPlanId, scopeKey]);

  // A plan an IVR digit targets is as much "in use" as a line's plan: the RPC
  // refuses to delete it and switching it off reroutes those callers silently.
  const planIdsInUse = useMemo(() => ringPlanIdsInUse(document.lines, document.ivrMenus), [document.ivrMenus, document.lines]);

  // The organisation fan-out cap is only visible to a manager/admin (the
  // limits are stripped for a member), so the preview simply omits the note
  // when it is unknown rather than guessing a number.
  const maxRingFanout = document.limits?.maxRingFanout;

  const issues = useMemo(
    () =>
      validateRingPlanDrafts(plans, {
        groups: document.groups,
        destinationAllowlist: document.limits?.destinationAllowlist ?? FALLBACK_DESTINATION_ALLOWLIST,
        planIdsInUse,
        maxRingFanout,
      }),
    [document.groups, document.limits, maxRingFanout, planIdsInUse, plans],
  );

  const issuesFor = useMemo(() => issuesByPath(issues), [issues]);
  const formIssues = [...(issuesFor.get("") ?? []), ...serverIssues];
  const dirty = ringPlansDirty(plans, document.plans);
  const visiblePlans = visiblePlanIds == null ? plans : plans.filter(plan => plan.id && visiblePlanIds.includes(plan.id));

  async function save() {
    if (saving || !canEdit) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    setServerIssues([]);
    try {
      const response = await saveRoutingConfig("ringPlans", { plans: ringPlansPayload(plans), version: document.routingVersion });
      onSaved(response);
      const saved = "Plány zvonenia sú uložené. Prebiehajúce hovory dozvonia podľa plánu, s ktorým začali.";
      setNotice(response.warning ? `${saved} ${response.warning}` : saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Plány zvonenia sa nepodarilo uložiť.");
      if (caught instanceof ConfigRequestError) setServerIssues(caught.issues);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={controlled ? "min-w-0" : "rounded-xl border border-zinc-200 bg-white p-4 sm:p-6"} aria-labelledby="ring-plans-heading">
      {!controlled && <SettingsSectionHeader
        icon={ListOrdered}
        title="Plány zvonenia"
        description="Komu hovor zazvoní a čo sa stane, keď ho nikto neprijme."
      />}
      <h3 id="ring-plans-heading" className="sr-only">Plány zvonenia</h3>

      <div className="grid gap-4">
        {!canEdit && <SettingsNotice tone="info">Nastavenia vidíš len na čítanie. Zmeny môže uložiť manažér alebo admin.</SettingsNotice>}
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
        {formIssues.length > 0 && <SettingsIssueList issues={formIssues} />}
        {document.groups.length === 0 && <SettingsNotice tone="warning">Najprv pridaj skupinu s členmi. Potom ju vyber v kroku plánu.</SettingsNotice>}

        {visiblePlans.map((plan) => {
          const references = referencesUsingPlan(plan.id, document.lines, document.ivrMenus);
          const effectivePlan = strategyOverride ? { ...plan, steps: plan.steps.map(step => ({ ...step, strategy: strategyOverride })) } : plan;
          const usage = planUsageNote(effectivePlan, document.lines, { ivrMenus: document.ivrMenus, groups: document.groups });
          return (
            <div
              key={plan.key}
              id={plan.id ? `ring-plan-${plan.id}` : undefined}
              tabIndex={-1}
              className="min-w-0 scroll-mt-4 outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-zinc-300"
            >
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                <h4 className="font-medium">{plan.name || "Nový plán"}</h4>
                {!plan.active && <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600">Vypnutý plán</span>}
                {references.length > 1 && <span>Zdieľaný plán · úpravy platia pre všetky jeho linky a voľby IVR ({references.length}).</span>}
              </div>
              {!plan.active && <p className="mb-4 text-sm text-amber-800">Tento plán sa nespustí. Jeho kroky ani nastavený koniec sa nepoužijú.</p>}
              {strategyOverride && <p className="mb-5 text-xs leading-5 text-zinc-500">Vybraná linka nastavuje zvonenie {STRATEGY_LABELS[strategyOverride]}. Spôsob uložený v jednotlivých krokoch sa pre túto linku nepoužije.</p>}
              <SettingsIssueList issues={issuesFor.get(plan.key) ?? []} />

              <div className="relative">
                <div className="relative pb-5">
                <div aria-hidden="true" className="pointer-events-none absolute -bottom-4 left-[13px] top-4 w-px bg-zinc-200" />
                {plan.steps.length === 0 ? (
                  <div className="relative mb-5 bg-white py-2 pl-9 text-sm leading-6 text-zinc-600 sm:pl-11">
                    Plán potrebuje aspoň jeden krok. Bez kroku systém rovno ponúkne spätné volanie; nastavený koniec plánu sa nepoužije.
                  </div>
                ) : (
                  <SortableList
                    items={plan.steps.map((step) => step.key)}
                    onMove={(activeKey, overKey) => setPlans((current) => moveStepInPlans(current, plan.key, activeKey, overKey))}
                  >
                    {plan.steps.map((step, index) => {
                      const group = document.groups.find((candidate) => candidate.id === step.ringGroupId);
                      const strategy = strategyOverride ?? step.strategy;
                      const timing = stepTiming({ ...step, strategy }, group);
                      const groupSelector = <div className="max-w-md">
                        <SettingsField label="Skupina">
                          <select aria-label="Skupina" className={settingsInputClass} disabled={!canEdit} value={step.ringGroupId}
                            onChange={(event) => setPlans((current) => updateStep(current, plan.key, step.key, { ringGroupId: event.target.value }))}>
                            <option value="">— vyber skupinu —</option>
                            {document.groups.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.active ? "" : " (neaktívna)"}</option>)}
                          </select>
                        </SettingsField>
                        <p className="mt-2 text-xs leading-5 text-zinc-500">Úpravy príjemcov sa prejavia vo všetkých krokoch, ktoré používajú túto skupinu.</p>
                      </div>;
                      return (
                        <RingingStep key={step.key} id={step.key} index={index} planName={plan.name} disabled={!canEdit}
                          onRemove={() => setPlans((current) => removeStep(current, plan.key, step.key))}>
                          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                            {strategyOverride ? (
                              <div>
                                <span className="mb-2 block text-xs font-medium text-zinc-500">Ako zvoní</span>
                                <p aria-label="Ako zvoní" className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-zinc-800">
                                  {strategy === "all" ? <Users size={16} aria-hidden="true" /> : <ListOrdered size={16} aria-hidden="true" />}
                                  {strategy === "all" ? "Všetci naraz" : "Postupne"}
                                  <span className="text-xs font-normal text-zinc-500">podľa linky</span>
                                </p>
                              </div>
                            ) : (
                              <fieldset disabled={!canEdit} role="radiogroup" aria-label="Ako zvoní">
                                <legend className="mb-2 text-xs font-medium text-zinc-500">Ako zvoní</legend>
                                <div className="inline-flex rounded-lg bg-zinc-100 p-1">
                                  {(["all", "ordered"] as const).map(option => {
                                    const Icon = option === "all" ? Users : ListOrdered;
                                    return <label key={option} className={`relative ${canEdit ? "cursor-pointer" : "cursor-default opacity-60"}`}>
                                      <input type="radio" name={`strategy-${plan.key}-${step.key}`} value={option} className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
                                        checked={step.strategy === option}
                                        onChange={() => setPlans(current => updateStep(current, plan.key, step.key, { strategy: option }))} />
                                      <span className="inline-flex min-h-9 items-center gap-2 rounded-md border border-transparent px-3 text-xs font-medium text-zinc-500 transition-colors peer-checked:border-zinc-200 peer-checked:bg-white peer-checked:text-zinc-950 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-zinc-500">
                                        <Icon size={15} aria-hidden="true" />{option === "all" ? "Všetci naraz" : "Postupne"}
                                      </span>
                                    </label>;
                                  })}
                                </div>
                              </fieldset>
                            )}
                            <label className="block">
                              <span className="mb-2 block text-xs font-medium text-zinc-500">{strategy === "all" ? "Spoločný čas zvonenia (s)" : "Predvolený čas na osobu (s)"}</span>
                              <span className="inline-flex h-11 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 focus-within:border-zinc-400 focus-within:ring-1 focus-within:ring-zinc-400">
                                <Clock3 size={15} className="text-zinc-400" aria-hidden="true" />
                                <input disabled={!canEdit} inputMode="numeric" title={`${MIN_TIMEOUT_SECS} až ${MAX_TIMEOUT_SECS} s`}
                                  className="w-10 bg-transparent text-right text-sm font-medium tabular-nums text-zinc-900 outline-none disabled:opacity-60"
                                  value={step.timeoutSecs}
                                  onChange={(event) => setPlans((current) => updateStep(current, plan.key, step.key, { timeoutSecs: event.target.value }))} />
                                <span aria-hidden="true" className="text-xs text-zinc-500">s</span>
                              </span>
                            </label>
                          </div>
                          {timing && <p className="mt-2 text-xs leading-5 text-zinc-500">
                            {timing.strategy === "all"
                              ? `Účinný čas kroku: najviac ${timing.stepSecs} s pre všetkých v jednom kole.`
                              : "Volá sa v poradí príjemcov. Vlastný čas pri osobe má prednosť pred predvoleným časom."}
                          </p>}
                          {strategy === "all" && group && typeof maxRingFanout === "number" && maxRingFanout > 0 && group.members.length > maxRingFanout && <p className="mt-2 text-xs leading-5 text-amber-800">Limit organizácie: v tomto kroku zazvoní najviac {maxRingFanout} príjemcom. Na ostatných sa nedostane.</p>}

                          <div className="mt-3">
                            {group && !group.active && <p className="mb-3 text-xs text-amber-800">Táto skupina je vypnutá. Hovor tento krok preskočí.</p>}
                            {group && renderGroupEditor ? renderGroupEditor(group.id, { strategy, timeoutSecs: Number(step.timeoutSecs), planId: plan.id, groupSelector }) : group && (
                              <ul className="divide-y divide-zinc-100">
                                {group.members.map(member => <li key={member.id} className="py-3 text-sm text-zinc-800">{member.memberKind === "operator" ? operatorNames.get(member.profileId ?? "") ?? "Operátor" : member.externalNumber ?? "Externé číslo"}</li>)}
                                {group.members.length === 0 && <li className="py-3 text-sm text-zinc-500">Zatiaľ bez členov</li>}
                              </ul>
                            )}
                          </div>
                          {(!group || !renderGroupEditor) && <details open={!group || focusGroupId === group.id || undefined} className="mt-2 text-xs">
                            <summary className="w-fit cursor-pointer py-1 text-zinc-500 hover:text-zinc-800">Zdieľaná skupina{group ? ` · ${group.name}` : " · vybrať skupinu"}</summary>
                            <div className="mt-2">{groupSelector}</div>
                          </details>}
                          <SettingsIssueList issues={issuesFor.get(step.key) ?? []} />
                        </RingingStep>
                      );
                    })}
                  </SortableList>
                )}

                <div className="relative pl-9 sm:pl-11">
                  <button type="button" disabled={!canEdit || document.groups.length === 0}
                    onClick={() => setPlans((current) => addStep(current, plan.key, document.groups[0]?.id ?? ""))}
                    className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50">
                    <Plus size={14} aria-hidden="true" />Pridať krok
                  </button>
                </div>
                </div>

                <div className="relative">
                  <span className="absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-full border border-zinc-200 bg-zinc-50 text-zinc-500"><ArrowDown size={14} aria-hidden="true" /></span>
                  <div className="min-w-0 pl-9 sm:pl-11">
                    <fieldset disabled={!canEdit} role="radiogroup" aria-label="Keď nikto nezdvihne">
                      <legend className="mb-2 flex min-h-9 items-center text-base font-semibold tracking-tight text-zinc-950">Keď nikto nezdvihne</legend>
                      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                        {FALLBACK_ORDER.map(kind => {
                          const choice = FALLBACK_CHOICES[kind];
                          const Icon = choice.icon;
                          return <label key={kind} className={`relative min-w-0 ${canEdit ? "cursor-pointer" : "cursor-default opacity-60"}`}>
                            <input type="radio" name={`fallback-${plan.key}`} value={kind} aria-label={choice.label} className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
                              checked={plan.fallbackKind === kind}
                              onChange={() => setPlans(current => updatePlan(current, plan.key, { fallbackKind: kind }))} />
                            <span className="flex h-full min-h-24 flex-col items-start rounded-xl border border-zinc-200 bg-white p-3 text-zinc-500 transition-colors peer-hover:border-zinc-300 peer-checked:border-yellow-400 peer-checked:bg-yellow-50/60 peer-checked:text-zinc-900 peer-focus-visible:ring-2 peer-focus-visible:ring-zinc-500">
                              <Icon size={19} strokeWidth={1.6} className="mb-2" aria-hidden="true" />
                              <span className="text-xs font-semibold sm:text-sm">{choice.label}</span>
                              <span className="mt-1 text-xs leading-4 text-zinc-500">{choice.hint}</span>
                            </span>
                          </label>;
                        })}
                      </div>
                    </fieldset>
                    <p className="mt-2 max-w-2xl text-xs leading-5 text-zinc-500">{FALLBACK_HELP[plan.fallbackKind]}</p>
                    {plan.fallbackKind === "external_number" && <div className="mt-4 max-w-sm">
                      <SettingsField label="Číslo presmerovania">
                        <PhoneNumberInput className={settingsInputClass} disabled={!canEdit} value={plan.fallbackNumber}
                          onChange={(value) => setPlans((current) => updatePlan(current, plan.key, { fallbackNumber: value }))} />
                        <PhoneNumberHint value={plan.fallbackNumber} />
                      </SettingsField>
                    </div>}
                  </div>
                </div>
              </div>

              <details open={!plan.active || plan.steps.length === 0 || (issuesFor.get(plan.key)?.length ?? 0) > 0 || undefined} className="mt-4 border-t border-zinc-100 pt-2 text-sm">
                <summary className="w-fit cursor-pointer py-2 text-xs font-medium text-zinc-500 hover:text-zinc-800">Názov, stav a použitie plánu</summary>
                <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                  <SettingsField label="Názov plánu">
                    <input className={settingsInputClass} disabled={!canEdit} value={plan.name}
                      onChange={(event) => setPlans((current) => updatePlan(current, plan.key, { name: event.target.value }))} />
                  </SettingsField>
                  <div className="flex flex-wrap items-end gap-3 pb-1">
                    <label className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-zinc-800">
                      <input type="checkbox" className="h-4 w-4 accent-zinc-900" disabled={!canEdit} checked={plan.active}
                        onChange={(event) => setPlans((current) => updatePlan(current, plan.key, { active: event.target.checked }))} />Aktívny
                    </label>
                    <button type="button" disabled={!canEdit || references.length > 0}
                      onClick={() => setPlans((current) => removePlan(current, plan.key))}
                      aria-label={`Odobrať plán ${plan.name || "bez názvu"}`}
                      title={references.length > 0 ? "Najprv zmeň všetky linky a voľby IVR, ktoré používajú tento plán." : "Odobrať plán z návrhu"}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-red-200 bg-white px-3 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400 disabled:hover:bg-white">
                      <Trash2 size={14} aria-hidden="true" />Odobrať plán
                    </button>
                  </div>
                </div>
                {references.length > 0 && <p className="mt-3 text-xs leading-5 text-zinc-500">Plán nemožno odobrať, kým ho používajú linky alebo IVR. Najprv zmeň ich priradenie; väzby sú uvedené nižšie.</p>}
                <p className="mt-3 text-xs leading-5 text-zinc-600">
                  {describeRingPlan(effectivePlan, document.groups, maxRingFanout)}
                  {plan.active && plan.steps.length > 0 && <span className="mt-1 block text-zinc-500">Nastavené maximum zvonenia (skutočný čas môže byť kratší): {ringPlanSeconds(effectivePlan, document.groups)} s.</span>}
                </p>
                {usage && <p className={`mt-2 text-xs leading-5 ${usage.tone === "warning" ? "text-amber-800" : "text-zinc-500"}`}>{usage.text}</p>}
                {references.length > 0 && <div className="mt-4 text-xs text-zinc-600">
                  <p className="font-medium">Použitie plánu a súvisiace nastavenia ({references.length})</p>
                  <ul className="mt-2 divide-y divide-zinc-100">
                    {references.map(reference => <li key={`${reference.kind}:${reference.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>{reference.kind === "line"
                        ? `Linka „${reference.label}“ (${reference.phoneNumber}) · ${reference.active ? "aktívna" : "neaktívna"}`
                        : `IVR „${reference.menuName}“${reference.digit ? `, voľba ${reference.digit}${reference.optionLabel ? ` – ${reference.optionLabel}` : ""}` : ""} · ${reference.active ? "aktívne" : "neaktívne"}`}</span>
                      <button type="button" onClick={reference.kind === "line" ? onNavigateToNumbers : onNavigateToIvr}
                        disabled={reference.kind === "line" ? !onNavigateToNumbers : !onNavigateToIvr}
                        className="min-h-8 rounded-md px-2 text-xs font-medium text-zinc-700 underline decoration-zinc-300 underline-offset-4 hover:bg-zinc-100 disabled:cursor-default disabled:opacity-50">
                        {reference.kind === "line" ? "Otvoriť čísla" : "Otvoriť IVR menu"}
                      </button>
                    </li>)}
                  </ul>
                </div>}
              </details>
            </div>
          );
        })}

        {plans.length === 0 && <SettingsNotice tone="warning">Zatiaľ nie je vytvorený žiadny plán zvonenia.</SettingsNotice>}
        {plans.length > 0 && visiblePlans.length === 0 && <SettingsNotice tone="info">Vybraná linka nemá priradený plán zvonenia ani plán v IVR. Priradenie upravíš v nastavení čísla.</SettingsNotice>}

        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-2">
          <button type="button" disabled={!canEdit} onClick={() => { setPlans((current) => addPlan(current)); onAddPlan?.(); }}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-2 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50">
            <Plus size={15} aria-hidden="true" />Pridať plán
          </button>
          {!controlled && <button type="button" disabled={!canEdit || saving || !dirty || issues.length > 0} onClick={() => void save()}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600">
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}Uložiť plány
          </button>}
          {!controlled && dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
          {issues.length > 0 && <span className="text-xs font-medium text-red-700">Najprv oprav označené polia.</span>}
        </div>
      </div>
    </section>
  );
}
