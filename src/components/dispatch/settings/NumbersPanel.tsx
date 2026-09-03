"use client";

import { useMemo, useState } from "react";
import { Hash, Loader2, Save } from "lucide-react";

import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

import { ConfigRequestError, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import {
  ENVIRONMENTS,
  ENVIRONMENT_LABELS,
  describeLineRouting,
  describeLineTitle,
  findLine,
  lineDirty,
  lineDraftsFromDocument,
  linePatch,
  lineWarnings,
  updateLine,
  validateLineDraft,
  type LineDraft,
  type LineValidationContext,
} from "./numbers-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";

/**
 * Numbers screen (plan "Fáza 3"): the DIDs already provisioned in the database,
 * with their label, partner and the routing they use — ring plan, IVR menu,
 * business hours — plus the active flag and the environment.
 *
 * Buying a number from Telnyx is deliberately **not** here: a new number is
 * added by an administrator, and the panel says so.
 *
 * The route patches one line at a time, so each card saves itself and only the
 * fields that changed travel to the server.
 */
export function NumbersPanel({
  canEdit,
  document,
  onSaved,
}: {
  canEdit: boolean;
  document: RoutingDocument;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const [lines, setLines] = useState<LineDraft[]>(() => lineDraftsFromDocument(document.lines));
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const context = useMemo<LineValidationContext>(
    () => ({ plans: document.plans, ivrMenus: document.ivrMenus, businessHours: document.businessHours }),
    [document.businessHours, document.ivrMenus, document.plans],
  );

  async function saveLine(draft: LineDraft) {
    const original = findLine(document.lines, draft.id);
    if (!canEdit || savingId || !original) return;
    const patch = linePatch(draft, original);
    if (Object.keys(patch).length === 0) return;

    setSavingId(draft.id);
    setError(null);
    setNotice(null);
    setServerIssues([]);
    try {
      const response = await saveRoutingConfig("numbers", { lineId: draft.id, patch }, { method: "PATCH" });
      onSaved(response);
      setNotice(`Linka ${draft.phoneNumber} je uložená. Prebiehajúce hovory sa nemenia.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Linku sa nepodarilo uložiť.");
      if (caught instanceof ConfigRequestError) setServerIssues(caught.issues);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white" aria-labelledby="numbers-heading">
      <SettingsSectionHeader icon={Hash} title="Čísla a linky" description="Kam patrí každé naše číslo a čo sa s hovorom na ňom stane." />

      <div className="grid gap-4 p-4">
        <h3 id="numbers-heading" className="sr-only">
          Čísla a linky
        </h3>

        {!canEdit && <SettingsNotice tone="info">Nastavenia vidíš len na čítanie. Zmeny môže uložiť manažér alebo admin.</SettingsNotice>}
        <SettingsNotice tone="info">Nové telefónne číslo objednáva a do systému pridáva administrátor. Tu sa dá existujúcemu číslu zmeniť len smerovanie.</SettingsNotice>
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
        {serverIssues.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <SettingsIssueList issues={serverIssues} />
          </div>
        )}

        {lines.length === 0 && <SettingsNotice tone="warning">V databáze zatiaľ nie je žiadne telefónne číslo.</SettingsNotice>}

        {lines.map((line) => {
          const original = findLine(document.lines, line.id);
          const issues = validateLineDraft(line, context);
          const warnings = lineWarnings(line, context);
          const dirty = original ? lineDirty(line, original) : false;
          const saving = savingId === line.id;

          return (
            <div key={line.id} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-zinc-950">{describeLineTitle(line)}</span>
                <span className="font-mono text-xs text-zinc-500">{line.phoneNumber}</span>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <SettingsField label="Štítok" hint="Zobrazuje sa operátorovi pri prichádzajúcom hovore.">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    value={line.label}
                    onChange={(event) => setLines((current) => updateLine(current, line.id, { label: event.target.value }))}
                  />
                </SettingsField>

                <SettingsField label="Partner" hint="Napríklad poisťovňa, pre ktorú je číslo vyhradené.">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    placeholder="bez partnera"
                    value={line.partnerName}
                    onChange={(event) => setLines((current) => updateLine(current, line.id, { partnerName: event.target.value }))}
                  />
                </SettingsField>

                <SettingsField label="Plán zvonenia">
                  <select
                    className={settingsInputClass}
                    disabled={!canEdit}
                    value={line.ringPlanId ?? ""}
                    onChange={(event) => setLines((current) => updateLine(current, line.id, { ringPlanId: event.target.value || null }))}
                  >
                    <option value="">— žiadny —</option>
                    {document.plans.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.name}
                        {plan.active ? "" : " (vypnutý)"}
                      </option>
                    ))}
                  </select>
                </SettingsField>

                <SettingsField label="IVR menu" hint="Voliteľné. Bez neho ide hovor rovno na plán zvonenia.">
                  <select
                    className={settingsInputClass}
                    disabled={!canEdit}
                    value={line.ivrMenuId ?? ""}
                    onChange={(event) => setLines((current) => updateLine(current, line.id, { ivrMenuId: event.target.value || null }))}
                  >
                    <option value="">— žiadne —</option>
                    {document.ivrMenus.map((menu) => (
                      <option key={menu.id} value={menu.id}>
                        {menu.name}
                        {menu.active ? "" : " (vypnuté)"}
                      </option>
                    ))}
                  </select>
                </SettingsField>

                <SettingsField label="Otváracie hodiny">
                  <select
                    className={settingsInputClass}
                    disabled={!canEdit}
                    value={line.businessHoursId ?? ""}
                    onChange={(event) => setLines((current) => updateLine(current, line.id, { businessHoursId: event.target.value || null }))}
                  >
                    <option value="">— nonstop —</option>
                    {document.businessHours.map((hours) => (
                      <option key={hours.id} value={hours.id}>
                        {hours.name}
                        {hours.active ? "" : " (vypnuté)"}
                      </option>
                    ))}
                  </select>
                </SettingsField>

                <SettingsField label="Prostredie" hint="Testovacia linka slúži na dev a preview.">
                  <select
                    className={settingsInputClass}
                    disabled={!canEdit}
                    value={line.environment}
                    onChange={(event) => setLines((current) => updateLine(current, line.id, { environment: event.target.value as LineDraft["environment"] }))}
                  >
                    {ENVIRONMENTS.map((environment) => (
                      <option key={environment} value={environment}>
                        {ENVIRONMENT_LABELS[environment]}
                      </option>
                    ))}
                  </select>
                </SettingsField>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#FCD703]"
                    disabled={!canEdit}
                    checked={line.active}
                    onChange={(event) => setLines((current) => updateLine(current, line.id, { active: event.target.checked }))}
                  />
                  Linka je aktívna
                </label>

                <button
                  type="button"
                  disabled={!canEdit || saving || !dirty || issues.length > 0}
                  onClick={() => void saveLine(line)}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
                >
                  {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
                  Uložiť linku
                </button>
                {dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
              </div>

              <p className="mt-2 text-xs text-zinc-600">{describeLineRouting(line, context)}</p>
              {warnings.map((warning) => (
                <p key={warning} className="mt-1 text-xs text-amber-700">
                  {warning}
                </p>
              ))}
              <SettingsIssueList issues={issues} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
