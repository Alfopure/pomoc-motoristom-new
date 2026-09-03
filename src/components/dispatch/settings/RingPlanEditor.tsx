"use client";

import { useMemo, useState } from "react";
import { ListOrdered, Loader2, Plus, Save, Trash2 } from "lucide-react";

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
  removeStep,
  ringPlanIdsInUse,
  ringPlanSeconds,
  ringPlansDirty,
  ringPlansPayload,
  updatePlan,
  updateStep,
  validateRingPlanDrafts,
  type PlanDraft,
} from "./ring-plan-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";
import { SortableList, SortableRow } from "./sortable-list";

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
  onSaved,
}: {
  canEdit: boolean;
  document: RoutingDocument;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const [plans, setPlans] = useState<PlanDraft[]>(() => planDraftsFromDocument(document.plans));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

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
    <section className="rounded-md border border-zinc-200 bg-white" aria-labelledby="ring-plans-heading">
      <SettingsSectionHeader
        icon={ListOrdered}
        title="Plány zvonenia"
        description="Poradie skupín, čas každého kroku a čo sa stane, keď nikto nezdvihne."
      />

      <div className="grid gap-4 p-4">
        <h3 id="ring-plans-heading" className="sr-only">
          Plány zvonenia
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
          <SettingsNotice tone="warning">Najprv vytvor a ulož skupinu zvonenia v záložke „Skupiny“, až potom sa dá poskladať plán.</SettingsNotice>
        )}

        {plans.map((plan) => (
          <div key={plan.key} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
              <SettingsField label="Názov plánu">
                <input
                  className={settingsInputClass}
                  disabled={!canEdit}
                  value={plan.name}
                  onChange={(event) => setPlans((current) => updatePlan(current, plan.key, { name: event.target.value }))}
                />
              </SettingsField>
              <div className="flex items-end pb-1">
                <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#FCD703]"
                    disabled={!canEdit}
                    checked={plan.active}
                    onChange={(event) => setPlans((current) => updatePlan(current, plan.key, { active: event.target.checked }))}
                  />
                  Aktívny
                </label>
              </div>
            </div>

            <p className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
              {describeRingPlan(plan, document.groups, maxRingFanout)}
              {plan.active && plan.steps.length > 0 && (
                <span className="mt-1 block text-xs text-blue-800">Najdlhšie zvonenie spolu: {ringPlanSeconds(plan, document.groups)} s.</span>
              )}
            </p>

            {(() => {
              const usage = planUsageNote(plan, document.lines, { ivrMenus: document.ivrMenus, groups: document.groups });
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

            <SettingsIssueList issues={issuesFor.get(plan.key) ?? []} />

            <div className="mt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase text-zinc-500">Kroky ({plan.steps.length})</span>
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
                  Plán potrebuje aspoň jeden krok. Bez kroku by hovor rovno skončil na náhradnom riešení.
                </p>
              ) : (
                <SortableList
                  items={plan.steps.map((step) => step.key)}
                  onMove={(activeKey, overKey) => setPlans((current) => moveStepInPlans(current, plan.key, activeKey, overKey))}
                >
                  {plan.steps.map((step, index) => (
                    <SortableRow key={step.key} id={step.key} disabled={!canEdit} handleLabel={`Presunúť ${index + 1}. krok plánu ${plan.name}`}>
                      <div className="grid gap-2 sm:grid-cols-[28px_minmax(0,1.4fr)_minmax(0,110px)_minmax(0,1fr)_auto] sm:items-end">
                        <span className="text-sm font-semibold text-zinc-500">{index + 1}.</span>

                        <SettingsField label="Skupina">
                          <select
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

                        <SettingsField label="Čas (s)">
                          <input
                            className={settingsInputClass}
                            disabled={!canEdit}
                            inputMode="numeric"
                            title={`${MIN_TIMEOUT_SECS} až ${MAX_TIMEOUT_SECS} s`}
                            value={step.timeoutSecs}
                            onChange={(event) => setPlans((current) => updateStep(current, plan.key, step.key, { timeoutSecs: event.target.value }))}
                          />
                        </SettingsField>

                        <SettingsField label="Ako zvoní">
                          <select
                            className={settingsInputClass}
                            disabled={!canEdit}
                            value={step.strategy}
                            onChange={(event) =>
                              setPlans((current) => updateStep(current, plan.key, step.key, { strategy: event.target.value === "ordered" ? "ordered" : "all" }))
                            }
                          >
                            <option value="all">{STRATEGY_LABELS.all}</option>
                            <option value="ordered">{STRATEGY_LABELS.ordered}</option>
                          </select>
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
                      <SettingsIssueList issues={issuesFor.get(step.key) ?? []} />
                    </SortableRow>
                  ))}
                </SortableList>
              )}
            </div>

            <div className="mt-3 grid gap-3 border-t border-zinc-200 pt-3 sm:grid-cols-2">
              <SettingsField label="Keď nikto nezdvihne">
                <select
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
              </SettingsField>

              {plan.fallbackKind === "external_number" && (
                <SettingsField label="Číslo presmerovania">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    inputMode="tel"
                    placeholder="+421900123456"
                    value={plan.fallbackNumber}
                    onChange={(event) => setPlans((current) => updatePlan(current, plan.key, { fallbackNumber: event.target.value }))}
                  />
                </SettingsField>
              )}
            </div>
          </div>
        ))}

        {plans.length === 0 && <SettingsNotice tone="warning">Zatiaľ nie je vytvorený žiadny plán zvonenia.</SettingsNotice>}

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => setPlans((current) => addPlan(current))}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={15} aria-hidden="true" />
            Pridať plán
          </button>
          <button
            type="button"
            disabled={!canEdit || saving || !dirty || issues.length > 0}
            onClick={() => void save()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            Uložiť plány
          </button>
          {dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
          {issues.length > 0 && <span className="text-xs font-medium text-red-700">Najprv oprav označené polia.</span>}
        </div>
      </div>
    </section>
  );
}
