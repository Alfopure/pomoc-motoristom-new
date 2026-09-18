"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Info, Loader2, Save, ShieldAlert } from "lucide-react";

import type { RoutingDocument, TelephonySettingsDoc, ValidationIssue } from "@/server/telephony/config-service";

import { callSetupAdvisories, type CallSetupAdvisory } from "@/lib/telephony/call-setup-advisories";
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
  document,
  settings,
  onSaved,
}: {
  canEdit: boolean;
  /** Groups and plans are needed to cross-check the allowlist and the fan-out cap. */
  document: RoutingDocument;
  settings: TelephonySettingsDoc;
  onSaved: (settings: TelephonySettingsDoc) => void;
}) {
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraftFromDocument(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const issues = useMemo(() => validateSettingsDraft(draft), [draft]);
  const warnings = useMemo(
    () => settingsWarnings(draft, settings, { groups: document.groups, plans: document.plans }),
    [document.groups, document.plans, draft, settings],
  );
  // What the setup already does, as opposed to what this save would change.
  // Nothing here is enforced: a configuration that leaves callers waiting is
  // allowed, it just should not be a surprise.
  const advisories = useMemo(
    () => callSetupAdvisories({
      groups: document.groups,
      plans: document.plans,
      operators: document.operators,
      parkMaxMinutes: settings.parkMaxMinutes,
      maxRingFanout: document.limits?.maxRingFanout ?? null,
    }),
    [document.groups, document.limits?.maxRingFanout, document.operators, document.plans, settings.parkMaxMinutes],
  );
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
      const { settings: saved, warning } = await saveTelephonySettings(settingsPayload(draft));
      onSaved(saved);
      setNotice(warning ? `Nastavenia telefónie sú uložené. ${warning}` : "Nastavenia telefónie sú uložené.");
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

        <CurrentCallBehaviour advisories={advisories} />

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
            <SettingsField
              label="Maximum v čakárni (min)"
              hint={`1 až ${MAX_PARK_MINUTES}. Potom systém ponúkne spätné volanie. Zmena platí pre hovory, ktoré do čakárne prídu po uložení; volajúci, ktorí v nej už čakajú, dočakajú podľa limitu platného v čase zaparkovania.`}
            >
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
            <SettingsField
              label="Denný limit hovorov"
              hint="Strop na počet liniek za deň. Po jeho dosiahnutí systém odmietne (429) odchádzajúce hovory, prepojenia aj spätné volania až do polnoci (Europe/Bratislava); prichádzajúcich volajúcich neodmieta."
            >
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
            <SettingsField
              label="Súčasných liniek spolu"
              hint="Strop pre celú organizáciu vrátane linky samotného volajúceho, takže musí byť aspoň o jednu vyšší ako počet súčasne zvoniacich zariadení; nad ním krok počká na kapacitu."
            >
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

const ADVISORY_TONE: Record<CallSetupAdvisory["tone"], string> = {
  info: "border-zinc-200 bg-zinc-50 text-zinc-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  error: "border-red-200 bg-red-50 text-red-900",
};

/**
 * What a caller meets with the configuration as it stands.
 *
 * Every line is derived from rows the admin can change on the other tabs, so
 * this is a reading of their own setup rather than advice: whether anybody's
 * phone rings, what happens when nobody picks up, and which of it is billed.
 */
function CurrentCallBehaviour({ advisories }: { advisories: CallSetupAdvisory[] }) {
  if (!advisories.length) return null;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-3" aria-label="Čo robí súčasné nastavenie">
      <h3 className="flex items-center gap-1.5 text-sm font-bold text-zinc-950">
        <Info size={14} aria-hidden="true" />
        Čo robí súčasné nastavenie
      </h3>
      <p className="mt-0.5 text-xs text-zinc-600">
        Vychádza z plánov zvonenia, skupín a nastavení operátorov. Nič z toho nie je vynútené — je to len to, čo sa na hovore naozaj stane.
      </p>
      <ul className="mt-2 grid gap-1.5">
        {advisories.map((advisory) => (
          <li key={advisory.title} className={`rounded-md border px-2.5 py-2 text-xs ${ADVISORY_TONE[advisory.tone]}`}>
            <span className="font-bold">{advisory.title}</span>
            <span className="mt-0.5 block font-medium leading-5">{advisory.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
