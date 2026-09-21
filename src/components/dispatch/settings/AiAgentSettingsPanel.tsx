"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, Sparkles } from "lucide-react";

import { SettingsField, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";

/**
 * How the assistant behaves.
 *
 * One screen, set once. The daily switch — online or offline — lives with the
 * operators, where every other presence does; duplicating it here would give
 * two places to set one thing.
 *
 * Nothing on this screen decides *when* she picks up. That is the ring plan.
 */

type Settings = {
  displayName: string;
  voice: string;
  introStyle: "expert_helper" | "assistant" | "custom";
  introCustom: string | null;
  standingRules: string | null;
  readsCallerCases: boolean;
  requiresPlateCheck: boolean;
  createsDraftCases: boolean;
  addsCaseNotes: boolean;
  smsEnabled: boolean;
  smsMaxPerCall: number;
  profileId: string | null;
};

type Limits = { nameMin: number; nameMax: number; introCustomMax: number; standingRulesMax: number };
type Voices = { all: readonly string[]; natural: readonly string[] };

const INTRO_LABELS: Record<Settings["introStyle"], string> = {
  expert_helper: "odborná pomocníčka / odborný pomocník",
  assistant: "automatická asistentka",
  custom: "vlastná veta",
};

/** Enforced by the server, listed here so an admin can see what they do not have to watch. */
const BOUNDARIES = [
  "Nevolá sama od seba.",
  "Neposiela voľný text, len schválené správy.",
  "Nezatvára ani neruší prípady.",
  "Nevidí nič, čo nepatrí k volajúcemu.",
  "Nesľubuje cenu ani termín.",
  "Nepýta si čísla kariet ani rodné čísla.",
];

export function AiAgentSettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [voices, setVoices] = useState<Voices>({ all: [], natural: [] });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The counter must follow the keyboard, not the last save.
  const [rulesDraft, setRulesDraft] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch("/api/telephony/ai-demo/settings", { cache: "no-store" });
        const body = await response.json();
        if (!alive) return;
        if (!response.ok) { setError(body?.error ?? "Nastavenia sa nepodarilo načítať."); return; }
        setSettings(body.settings);
        setRulesDraft(body.settings?.standingRules ?? "");
        setLimits(body.limits);
      if (body.voices) setVoices(body.voices);
      } catch {
        if (alive) setError("Nastavenia sa nepodarilo načítať.");
      }
    })();
    return () => { alive = false; };
  }, []);

  const patch = useCallback(async (change: Partial<Settings>) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/telephony/ai-demo/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const body = await response.json();
      if (!response.ok) { setError(body?.error ?? "Uložiť sa to nepodarilo."); return; }
      setSettings(body.settings);
      setSaved(true);
    } catch {
      setError("Uložiť sa to nepodarilo.");
    } finally {
      setSaving(false);
    }
  }, []);

  if (error && !settings) return <SettingsNotice tone="error">{error}</SettingsNotice>;
  if (!settings || !limits) {
    return <p className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Načítavam…</p>;
  }

  const rulesLength = rulesDraft.length;
  const rulesOver = rulesLength > limits.standingRulesMax;

  return (
    <section className="grid gap-6" aria-label="Nastavenia AI pomocníčky">
      <SettingsSectionHeader icon={Sparkles} title="Ako sa má správať" description="Nastavíš raz. Kedy dvíha, určuje plán zvonenia — nie táto obrazovka." />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
      {saved && !saving && <SettingsNotice tone="success">Uložené.</SettingsNotice>}

      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField label="Meno" hint={`${limits.nameMin}–${limits.nameMax} znakov. Takto sa predstaví.`}>
          <input
            type="text"
            className={settingsInputClass}
            defaultValue={settings.displayName}
            maxLength={limits.nameMax}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value && value !== settings.displayName) void patch({ displayName: value });
            }}
          />
        </SettingsField>

        <SettingsField label="Hlas" hint="Nahrávané hlasy znejú ľudskejšie. Rod oslovenia sa odvodí od hlasu.">
          <select
            className={settingsInputClass}
            value={settings.voice}
            onChange={(event) => void patch({ voice: event.target.value })}
          >
            {voices.all.map((voice) => (
              <option key={voice} value={voice}>
                {voice}{voices.natural.includes(voice) ? " — prirodzený" : ""}
              </option>
            ))}
          </select>
        </SettingsField>
      </div>

      <SettingsField label="Ako sa predstaví">
        <select
          className={settingsInputClass}
          value={settings.introStyle}
          onChange={(event) => {
            const style = event.target.value as Settings["introStyle"];
            // The table refuses `custom` without a sentence, so the two travel
            // together — otherwise the save fails and the field that would let
            // you fix it never appears.
            if (style !== "custom") { void patch({ introStyle: style }); return; }
            const sentence = (settings.introCustom ?? "").trim() || "Som tu, aby som vám pomohla.";
            void patch({ introStyle: style, introCustom: sentence });
          }}
        >
          {(Object.keys(INTRO_LABELS) as Array<Settings["introStyle"]>).map((style) => (
            <option key={style} value={style}>{INTRO_LABELS[style]}</option>
          ))}
        </select>
      </SettingsField>

      {settings.introStyle === "custom" && (
        <SettingsField label="Vlastná veta" hint={`Najviac ${limits.introCustomMax} znakov.`}>
          <input
            type="text"
            className={settingsInputClass}
            defaultValue={settings.introCustom ?? ""}
            maxLength={limits.introCustomMax}
            onBlur={(event) => void patch({ introCustom: event.target.value })}
          />
        </SettingsField>
      )}

      <SettingsField
        label="Stále pravidlá"
        hint="Platia pri každom hovore. Drž ich krátke — dlhé zadanie ju spomalí a začne znieť ako čítaný manuál."
      >
        <textarea
          rows={4}
          className={settingsInputClass}
          value={rulesDraft}
          maxLength={limits.standingRulesMax}
          onChange={(event) => setRulesDraft(event.target.value)}
          onBlur={(event) => {
            if (event.target.value !== (settings.standingRules ?? "")) void patch({ standingRules: event.target.value });
          }}
        />
        <p className={`mt-1 text-xs ${rulesOver ? "font-semibold text-red-600" : "text-zinc-500"}`}>
          {rulesLength} / {limits.standingRulesMax} znakov
        </p>
      </SettingsField>

      <SettingsSectionHeader icon={ShieldCheck} title="Prípady" description="Čo je vypnuté, o tom model ani nevie. Označené položky sú navrhnuté, ale ešte nepostavené." />
      <div className="grid gap-2">
        <Toggle label="Vidí prípady volajúceho" checked={settings.readsCallerCases} onChange={(value) => void patch({ readsCallerCases: value })} />
        <Toggle label="Pýta si EČV pred detailmi" checked={settings.requiresPlateCheck} onChange={(value) => void patch({ requiresPlateCheck: value })} />
        <Toggle pending label="Zakladá prípady ako návrh na potvrdenie" checked={settings.createsDraftCases} onChange={(value) => void patch({ createsDraftCases: value })} />
        <Toggle pending label="Pridáva poznámku k prípadu" checked={settings.addsCaseNotes} onChange={(value) => void patch({ addsCaseNotes: value })} />
      </div>

      <SettingsSectionHeader icon={ShieldCheck} title="SMS" description="Navrhnuté, ešte nepostavené. Keď to bude hotové, pôjdu len schválené správy a len na číslo, z ktorého sa volá." />
      <div className="grid gap-2">
        <Toggle pending label="Smie poslať SMS" checked={settings.smsEnabled} onChange={(value) => void patch({ smsEnabled: value })} />
        <SettingsField label="Najviac za hovor">
          <select
            className={settingsInputClass}
            value={settings.smsMaxPerCall}
            disabled={!settings.smsEnabled}
            onChange={(event) => void patch({ smsMaxPerCall: Number(event.target.value) })}
          >
            {[1, 2, 3].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </SettingsField>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-800">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          Hranice, ktoré sa nedajú vypnúť
        </h3>
        <ul className="mt-2 grid gap-1 text-sm text-zinc-600">
          {BOUNDARIES.map((line) => <li key={line}>• {line}</li>)}
        </ul>
      </div>

      {saving && <p className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Ukladám…</p>}
    </section>
  );
}

/**
 * A permission switch.
 *
 * `pending` marks a capability that is designed but not built. It is shown
 * rather than hidden so the shape of the thing is visible, but it cannot be
 * switched on: a box that ticks and does nothing is worse than no box, and the
 * one for sending SMS is the reason this matters — somebody would reasonably
 * believe she could text a customer.
 */
function Toggle({ checked, label, onChange, pending }: { checked: boolean; label: string; onChange: (value: boolean) => void; pending?: boolean }) {
  return (
    <label className={`flex items-center gap-2 text-sm ${pending ? "text-zinc-400" : "text-zinc-800"}`}>
      <input
        type="checkbox"
        checked={pending ? false : checked}
        disabled={pending}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4"
      />
      {label}
      {pending && <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-medium text-zinc-600">zatiaľ nie je hotové</span>}
    </label>
  );
}
