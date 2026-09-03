"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, Save, ShieldAlert } from "lucide-react";

import type { TelephonySettingsDoc, ValidationIssue } from "@/server/telephony/config-service";

import { ConfigRequestError, saveTelephonySettings } from "./config-client";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";
import {
  ENV_GATE_NOTE,
  MAX_PARK_MINUTES,
  describeAllowlist,
  describeKillSwitches,
  settingsDirty,
  settingsDraftFromDocument,
  settingsPayload,
  settingsWarnings,
  updateSettingsDraft,
  validateSettingsDraft,
  type SettingsDraft,
} from "./telephony-settings-model";

/**
 * Organisation telephony settings (plan "Fáza 3"), admin only.
 *
 * The two kill switches are the reason this screen exists: with them off the
 * system never dials and never sends an SMS, and turning one on is the moment
 * real numbers get called and real money gets spent. The panel therefore states
 * the consequence in words before the save, not after it.
 */
export function TelephonySettingsPanel({
  canEdit,
  settings,
  onSaved,
}: {
  canEdit: boolean;
  settings: TelephonySettingsDoc;
  onSaved: (settings: TelephonySettingsDoc) => void;
}) {
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraftFromDocument(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const issues = useMemo(() => validateSettingsDraft(draft), [draft]);
  const warnings = useMemo(() => settingsWarnings(draft, settings), [draft, settings]);
  const dirty = settingsDirty(draft, settings);
  const issuesFor = (path: string) => issues.filter((issue) => issue.path === path);

  function set(patch: Partial<SettingsDraft>) {
    setDraft((current) => updateSettingsDraft(current, patch));
  }

  async function save() {
    if (saving || !canEdit) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    setServerIssues([]);
    try {
      const saved = await saveTelephonySettings(settingsPayload(draft));
      onSaved(saved);
      setNotice("Nastavenia telefónie sú uložené.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nastavenia telefónie sa nepodarilo uložiť.");
      if (caught instanceof ConfigRequestError) setServerIssues(caught.issues);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white" aria-labelledby="telephony-settings-heading">
      <SettingsSectionHeader icon={ShieldAlert} title="Bezpečnostné nastavenia telefónie" description="Ostrá prevádzka, povolené ciele a limity. Len pre administrátora." />

      <div className="grid gap-4 p-4">
        <h3 id="telephony-settings-heading" className="sr-only">
          Bezpečnostné nastavenia telefónie
        </h3>

        {!canEdit && <SettingsNotice tone="info">Tieto nastavenia môže meniť len administrátor.</SettingsNotice>}
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
        {serverIssues.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <SettingsIssueList issues={serverIssues} />
          </div>
        )}

        <div className="rounded-md border-2 border-red-300 bg-red-50 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-700" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-red-900">Ostrá prevádzka</p>
              <p className="mt-0.5 text-sm text-red-900">
                Kým sú tieto prepínače vypnuté, systém nikam nevolá a neposiela žiadne SMS. Po zapnutí volá na skutočné čísla skutočným ľuďom a hovory aj správy sa
                účtujú.
              </p>
              <p className="mt-1 text-xs text-red-800">{ENV_GATE_NOTE}</p>
            </div>
          </div>

          <div className="mt-3 grid gap-2">
            <label className="flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-900">
              <input
                type="checkbox"
                className="h-4 w-4 accent-red-600"
                disabled={!canEdit}
                checked={draft.liveCallsEnabled}
                onChange={(event) => set({ liveCallsEnabled: event.target.checked })}
              />
              Ostré hovory (systém smie volať)
            </label>
            <label className="flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-900">
              <input
                type="checkbox"
                className="h-4 w-4 accent-red-600"
                disabled={!canEdit}
                checked={draft.smsLiveSends}
                onChange={(event) => set({ smsLiveSends: event.target.checked })}
              />
              Ostré SMS (systém smie odosielať správy)
            </label>
            <p className="text-xs font-medium text-red-900">{describeKillSwitches(draft)}</p>
          </div>
        </div>

        {warnings.map((warning) => (
          <SettingsNotice key={warning.text} tone={warning.tone}>
            {warning.text}
          </SettingsNotice>
        ))}

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <SettingsField
              label="Povolené ciele"
              hint="Kódy krajín (SK, CZ) alebo predvoľby (+43), oddelené čiarkou. Volať sa dá len na čísla z tohto zoznamu."
            >
              <input
                className={settingsInputClass}
                disabled={!canEdit}
                placeholder="SK, CZ"
                value={draft.destinationAllowlist}
                onChange={(event) => set({ destinationAllowlist: event.target.value })}
              />
            </SettingsField>
            <p className="mt-1 text-xs text-zinc-600">Povolené: {describeAllowlist(draft)}</p>
            <SettingsIssueList issues={issuesFor("destinationAllowlist")} />
          </div>

          <div>
            <SettingsField label="Maximum v čakárni (min)" hint={`1 až ${MAX_PARK_MINUTES}. Potom systém ponúkne spätné volanie.`}>
              <input
                className={settingsInputClass}
                disabled={!canEdit}
                inputMode="numeric"
                value={draft.parkMaxMinutes}
                onChange={(event) => set({ parkMaxMinutes: event.target.value })}
              />
            </SettingsField>
            <SettingsIssueList issues={issuesFor("parkMaxMinutes")} />
          </div>

          <div>
            <SettingsField label="Denný limit hovorov" hint="Mäkký strop na počet liniek za deň; po prekročení sa zapíše incident.">
              <input
                className={settingsInputClass}
                disabled={!canEdit}
                inputMode="numeric"
                value={draft.dailyLegSoftCap}
                onChange={(event) => set({ dailyLegSoftCap: event.target.value })}
              />
            </SettingsField>
            <SettingsIssueList issues={issuesFor("dailyLegSoftCap")} />
          </div>

          <div>
            <SettingsField label="Súčasne zvoniacich zariadení" hint="Koľko členov skupiny smie zvoniť naraz v jednom kroku.">
              <input
                className={settingsInputClass}
                disabled={!canEdit}
                inputMode="numeric"
                value={draft.maxRingFanout}
                onChange={(event) => set({ maxRingFanout: event.target.value })}
              />
            </SettingsField>
            <SettingsIssueList issues={issuesFor("maxRingFanout")} />
          </div>

          <div>
            <SettingsField label="Súčasných liniek spolu" hint="Strop pre celú organizáciu; nad ním krok počká na kapacitu.">
              <input
                className={settingsInputClass}
                disabled={!canEdit}
                inputMode="numeric"
                value={draft.maxConcurrentLegs}
                onChange={(event) => set({ maxConcurrentLegs: event.target.value })}
              />
            </SettingsField>
            <SettingsIssueList issues={issuesFor("maxConcurrentLegs")} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3">
          <button
            type="button"
            disabled={!canEdit || saving || !dirty || issues.length > 0}
            onClick={() => void save()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            Uložiť nastavenia
          </button>
          {dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
          {issues.length > 0 && <span className="text-xs font-medium text-red-700">Najprv oprav označené polia.</span>}
        </div>
      </div>
    </section>
  );
}
