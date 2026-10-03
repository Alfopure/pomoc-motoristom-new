"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import { ArrowDown, ListOrdered, Loader2, Plus, Save, Trash2, Users } from "lucide-react";

import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

import { ConfigRequestError, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { FALLBACK_DESTINATION_ALLOWLIST, issuesByPath } from "./ring-groups-model";
import {
  FALLBACK_LABELS,
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
import { SortableList, SortableRow } from "./sortable-list";
import { PhoneNumberHint, PhoneNumberInput } from "../PhoneNumberInput";

const FALLBACK_HELP: Record<PlanDraft["fallbackKind"], string> = {
  waiting_room: "Volajúci zostane v čakárni. Systém bude hovor znovu ponúkať dostupným operátorom v aplikácii; prevziať ho možno aj ručne.",
  external_number: "Číslo sa vytočí raz. Pri neprijatí nasleduje ponuka spätného volania, ak je číslo volajúceho známe.",
  callback_prompt: "Volajúci môže požiadať o spätné volanie, ak je jeho telefónne číslo známe.",
  hangup_message: "Prehrá sa záverečná hláška a hovor sa ukončí.",
};

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
  renderGroupEditor?: (groupId: string, context: { strategy: "all" | "ordered"; timeoutSecs: number; planId: string | null }) => ReactNode;
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
    <section className={controlled ? "min-w-0 rounded-xl border border-zinc-200 bg-white" : "rounded-md border border-zinc-200 bg-white"} aria-labelledby="ring-plans-heading">
      {!controlled && <SettingsSectionHeader
        icon={ListOrdered}
        title="Plány zvonenia"
        description="Poradie skupín, čas každého kroku a čo sa stane, keď nikto nezdvihne."
      />}

      <div className="grid gap-4 p-4">
        <h3 id="ring-plans-heading" className={controlled ? "text-sm font-semibold text-zinc-900" : "sr-only"}>
          {controlled ? "Poradie zvonenia" : "Plány zvonenia"}
        </h3>

        {!canEdit && <SettingsNotice tone="info">Nastavenia vidíš len na čítanie. Zmeny môže uložiť manažér alebo admin.</SettingsNotice>}
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
        {formIssues.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <SettingsIssueList issues={formIssues} />
          </div>
        )}
        {document.groups.length === 0 && (
          <SettingsNotice tone="warning">Najprv pridaj skupinu s členmi. Potom ju vyber v kroku plánu.</SettingsNotice>
        )}

        {visiblePlans.map((plan) => {
          const references = referencesUsingPlan(plan.id, document.lines, document.ivrMenus);
          const effectivePlan = strategyOverride ? { ...plan, steps: plan.steps.map(step => ({ ...step, strategy: strategyOverride })) } : plan;
          return (
          <div
            key={plan.key}
            id={plan.id ? `ring-plan-${plan.id}` : undefined}
            tabIndex={-1}
            className={`scroll-mt-4 rounded-xl border border-zinc-200 bg-white p-4 outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 ${focusPlanId === plan.id ? "border-zinc-400" : ""}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold text-zinc-900">{plan.name || "Nový plán"}</h4><span className="text-xs text-zinc-500">{plan.active ? "Aktívny plán" : "Vypnutý plán"}</span></div>
            {!plan.active && <p className="mt-2 text-sm text-amber-800">Tento plán sa nespustí. Jeho kroky ani nastavený koniec sa nepoužijú.</p>}
            <details open={!plan.active || plan.steps.length === 0 || undefined} className="mt-2 text-sm">
              <summary className="cursor-pointer py-2 text-xs font-medium text-zinc-500">Názov, stav a použitie plánu</summary>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
              <SettingsField label="Názov plánu">
                <input
                  className={settingsInputClass}
                  disabled={!canEdit}
                  value={plan.name}
                  onChange={(event) => setPlans((current) => updatePlan(current, plan.key, { name: event.target.value }))}
                />
              </SettingsField>
              <div className="flex items-end gap-2 pb-1">
                <label className="inline-flex h-10 items-center gap-2 text-sm font-medium text-zinc-800">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#FCD703]"
                    disabled={!canEdit}
                    checked={plan.active}
                    onChange={(event) => setPlans((current) => updatePlan(current, plan.key, { active: event.target.checked }))}
                  />
                  Aktívny
                </label>
                <button
                  type="button"
                  disabled={!canEdit || references.length > 0}
                  onClick={() => setPlans((current) => removePlan(current, plan.key))}
                  aria-label={`Odobrať plán ${plan.name || "bez názvu"}`}
                  title={references.length > 0 ? "Najprv zmeň všetky linky a voľby IVR, ktoré používajú tento plán." : "Odobrať plán z návrhu"}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-red-200 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400 disabled:hover:bg-white"
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Odobrať plán
                </button>
              </div>
            </div>
            {references.length > 0 && <p className="mt-2 text-xs text-zinc-500">Plán nemožno odobrať, kým ho používajú linky alebo IVR. Najprv zmeň ich priradenie; väzby sú uvedené nižšie.</p>}

            <p className="mt-3 text-xs leading-5 text-zinc-600">
              {describeRingPlan(effectivePlan, document.groups, maxRingFanout)}
              {plan.active && plan.steps.length > 0 && (
                <span className="mt-1 block text-xs text-zinc-500">Nastavené maximum zvonenia (skutočný čas môže byť kratší): {ringPlanSeconds(effectivePlan, document.groups)} s.</span>
              )}
            </p>

            {(() => {
              const usage = planUsageNote(effectivePlan, document.lines, { ivrMenus: document.ivrMenus, groups: document.groups });
              if (!usage) return null;
              return (
                <p
                  className={`mt-2 rounded-md border px-3 py-2 text-xs font-medium ${
                    usage.tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-zinc-200 bg-white text-zinc-600"
                  }`}
                >
                  {usage.text}
                </p>
              );
            })()}

            {references.length > 0 && (
              <details className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                <summary className="cursor-pointer font-medium">Použitie plánu a súvisiace nastavenia ({references.length})</summary>
                <p className="mt-2">Plán nemožno odobrať, kým ho používajú tieto väzby:</p>
                <ul className="mt-1 grid gap-1">
                  {references.map((reference) => (
                    <li key={`${reference.kind}:${reference.id}`} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {reference.kind === "line"
                          ? `Linka „${reference.label}“ (${reference.phoneNumber}) · ${reference.active ? "aktívna" : "neaktívna"}`
                          : `IVR „${reference.menuName}“${reference.digit ? `, voľba ${reference.digit}${reference.optionLabel ? ` – ${reference.optionLabel}` : ""}` : ""} · ${reference.active ? "aktívne" : "neaktívne"}`}
                      </span>
                      <button
                        type="button"
                        onClick={reference.kind === "line" ? onNavigateToNumbers : onNavigateToIvr}
                        disabled={reference.kind === "line" ? !onNavigateToNumbers : !onNavigateToIvr}
                        className="min-h-8 rounded-md border border-amber-300 bg-white px-2 font-semibold hover:bg-amber-100 disabled:cursor-default"
                      >
                        {reference.kind === "line" ? "Otvoriť čísla" : "Otvoriť IVR menu"}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            </details>
            {references.length > 1 && <p className="mt-2 text-xs text-zinc-500">Zdieľaný plán · úpravy platia pre všetky jeho linky a voľby IVR ({references.length}).</p>}
            {strategyOverride && <p className="mt-2 text-xs text-zinc-600">Vybraná linka nastavuje zvonenie {STRATEGY_LABELS[strategyOverride]}. Spôsob uložený v jednotlivých krokoch sa pre túto linku nepoužije.</p>}

            <SettingsIssueList issues={issuesFor.get(plan.key) ?? []} />

            <div className="mt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-xs font-semibold text-zinc-500"><Users size={15} aria-hidden="true" />Komu zvoní · kroky ({plan.steps.length})</span>
                <button
                  type="button"
                  disabled={!canEdit || document.groups.length === 0}
                  onClick={() => setPlans((current) => addStep(current, plan.key, document.groups[0]?.id ?? ""))}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus size={14} aria-hidden="true" />
                  Pridať krok
                </button>
              </div>

              {plan.steps.length === 0 ? (
                <p className="rounded-md border border-dashed border-zinc-300 px-3 py-3 text-xs text-zinc-600">
                  Plán potrebuje aspoň jeden krok. Bez kroku systém rovno ponúkne spätné volanie; nastavený koniec plánu sa nepoužije.
                </p>
              ) : (
                <SortableList
                  items={plan.steps.map((step) => step.key)}
                  onMove={(activeKey, overKey) => setPlans((current) => moveStepInPlans(current, plan.key, activeKey, overKey))}
                >
                  {plan.steps.map((step, index) => {
                    const group = document.groups.find((candidate) => candidate.id === step.ringGroupId);
                    const strategy = strategyOverride ?? step.strategy;
                    const timing = stepTiming({ ...step, strategy }, group);
                    return (
                    <SortableRow key={step.key} id={step.key} disabled={!canEdit} handleLabel={`Presunúť ${index + 1}. krok plánu ${plan.name}`}>
                      <div className="grid gap-3 lg:grid-cols-[28px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,170px)_auto] lg:items-end">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">{index + 1}</span>

                        <SettingsField label="Skupina">
                          <select aria-label="Skupina"
                            className={settingsInputClass}
                            disabled={!canEdit}
                            value={step.ringGroupId}
                            onChange={(event) => setPlans((current) => updateStep(current, plan.key, step.key, { ringGroupId: event.target.value }))}
                          >
                            <option value="">— vyber skupinu —</option>
                            {document.groups.map((group) => (
                              <option key={group.id} value={group.id}>
                                {group.name}
                                {group.active ? "" : " (neaktívna)"}
                              </option>
                            ))}
                          </select>
                        </SettingsField>

                        <SettingsField label="Ako zvoní">
                          {strategyOverride ? <p className="flex min-h-10 items-center rounded-md bg-zinc-50 px-3 text-sm text-zinc-700">{STRATEGY_LABELS[strategy]}</p> : <select aria-label="Ako zvoní"
                            className={settingsInputClass}
                            disabled={!canEdit}
                            value={step.strategy}
                            onChange={(event) =>
                              setPlans((current) => updateStep(current, plan.key, step.key, { strategy: event.target.value === "ordered" ? "ordered" : "all" }))
                            }
                          >
                            <option value="all">{STRATEGY_LABELS.all}</option>
                            <option value="ordered">{STRATEGY_LABELS.ordered}</option>
                          </select>}
                        </SettingsField>

                        <SettingsField label={strategy === "all" ? "Spoločný čas zvonenia (s)" : "Predvolený čas na osobu (s)"}>
                          <input
                            className={settingsInputClass}
                            disabled={!canEdit}
                            inputMode="numeric"
                            title={`${MIN_TIMEOUT_SECS} až ${MAX_TIMEOUT_SECS} s`}
                            value={step.timeoutSecs}
                            onChange={(event) => setPlans((current) => updateStep(current, plan.key, step.key, { timeoutSecs: event.target.value }))}
                          />
                        </SettingsField>

                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={() => setPlans((current) => removeStep(current, plan.key, step.key))}
                          aria-label={`Odobrať ${index + 1}. krok plánu ${plan.name}`}
                          className="mb-1 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          Odobrať
                        </button>
                      </div>
                      {timing && (
                        <p className="mt-2 text-xs leading-5 text-zinc-500">
                          <span className="font-semibold">Účinný čas kroku:</span>{" "}
                          {timing.strategy === "all"
                            ? `najviac ${timing.stepSecs} s pre všetkých v jednom kole.`
                            : timing.members.map((entry) => {
                                const member = group?.members.find((candidate) => candidate.id === entry.memberId);
                                const label = member?.memberKind === "operator"
                                  ? operatorNames.get(member.profileId ?? "") ?? "Neznámy operátor"
                                  : member?.externalNumber ?? "Externé číslo";
                                return `${label}: ${entry.effectiveSecs} s (${entry.source === "step" ? "preberá čas kroku" : "vlastný čas"})`;
                              }).join("; ") + "."}
                        </p>
                      )}
                      {group && renderGroupEditor && <details open={focusGroupId === group.id || undefined} className="mt-3 rounded-lg border border-zinc-200 bg-white">
                        <summary className="cursor-pointer px-3 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-zinc-400"><span className="text-zinc-500">Členovia skupiny:</span> {group.members.map(member => member.memberKind === "operator" ? operatorNames.get(member.profileId ?? "") ?? "Operátor" : member.externalNumber ?? "Externé číslo").join(", ") || "Zatiaľ bez členov"}<span className="ml-2 text-xs text-zinc-500">Upraviť členov</span></summary>
                        {renderGroupEditor(group.id, { strategy, timeoutSecs: Number(step.timeoutSecs), planId: plan.id })}
                      </details>}
                      <SettingsIssueList issues={issuesFor.get(step.key) ?? []} />
                    </SortableRow>
                    );
                  })}
                </SortableList>
              )}
            </div>

            <div className="my-3 flex items-center gap-2 text-xs text-zinc-500"><ArrowDown size={14} aria-hidden="true" />Po poslednom kroku</div>
            <div className="grid gap-3 rounded-lg bg-zinc-50 p-3 sm:grid-cols-2">
              <SettingsField label="Keď nikto nezdvihne">
                <select aria-label="Keď nikto nezdvihne"
                  className={settingsInputClass}
                  disabled={!canEdit}
                  value={plan.fallbackKind}
                  onChange={(event) => setPlans((current) => updatePlan(current, plan.key, { fallbackKind: event.target.value as PlanDraft["fallbackKind"] }))}
                >
                  {FALLBACK_ORDER.map((kind) => (
                    <option key={kind} value={kind}>
                      {FALLBACK_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <span className="mt-2 block text-xs leading-5 text-zinc-500">{FALLBACK_HELP[plan.fallbackKind]}</span>
              </SettingsField>

              {plan.fallbackKind === "external_number" && (
                <SettingsField label="Číslo presmerovania">
                  <PhoneNumberInput
                    className={settingsInputClass}
                    disabled={!canEdit}
                    value={plan.fallbackNumber}
                    onChange={(value) => setPlans((current) => updatePlan(current, plan.key, { fallbackNumber: value }))}
                  />
                  <PhoneNumberHint value={plan.fallbackNumber} />
                </SettingsField>
              )}
            </div>
          </div>
          );
        })}

        {plans.length === 0 && <SettingsNotice tone="warning">Zatiaľ nie je vytvorený žiadny plán zvonenia.</SettingsNotice>}
        {plans.length > 0 && visiblePlans.length === 0 && <SettingsNotice tone="info">Vybraná linka nemá priradený plán zvonenia ani plán v IVR. Priradenie upravíš v nastavení čísla.</SettingsNotice>}

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => { setPlans((current) => addPlan(current)); onAddPlan?.(); }}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={15} aria-hidden="true" />
            Pridať plán
          </button>
          {!controlled && <button
            type="button"
            disabled={!canEdit || saving || !dirty || issues.length > 0}
            onClick={() => void save()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            Uložiť plány
          </button>}
          {!controlled && dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
          {issues.length > 0 && <span className="text-xs font-medium text-red-700">Najprv oprav označené polia.</span>}
        </div>
      </div>
    </section>
  );
}
