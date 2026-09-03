"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Coffee, Headphones, Loader2, PhoneCall, PhoneOff, Save, Smartphone } from "lucide-react";

import { TELEPHONY_TIMEOUT_MS, telephonyJson } from "@/lib/telephony/client-request";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import {
  applyAudioOutput,
  audioOutputMissing,
  audioOutputSupported,
  listAudioOutputs,
  readStoredAudioOutput,
  remoteAudioElement,
  selectedAudioOutput,
  storeAudioOutput,
  type AudioOutputOption,
} from "@/lib/telephony/audio-output";
import type { RoutingDocument } from "@/server/telephony/config-service";

import { ConfigRequestError, loadRoutingConfig, saveOperatorSettings, type RoutingConfigResponse } from "./settings/config-client";
import {
  describeDevice,
  describeLineOption,
  activeLines,
  findOperator,
  operatorDraft,
  operatorDirty,
  operatorPatch,
  validateOperatorDraft,
  type OperatorDraft,
} from "./settings/operators-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass, useSecondClock } from "./settings/settings-ui";
import {
  activePauseReasons,
  canChangePresence,
  canEndWrapUp,
  checkTestCallNumber,
  confirmTestCall,
  describePauseReason,
  describePresence,
  describeWrapUp,
  presenceLabel,
  presenceTone,
  testCallTarget,
  type MyPresence,
  type MyPresenceResponse,
} from "./my-phone-model";

/**
 * "Môj telefón" (plan "Fáza 3"): the operator's own view of the telephony
 * stack — presence with a pause reason, the wrap-up countdown, the speaker the
 * browser plays calls through, a test call from their own line and the handful
 * of settings the server lets them change for themselves.
 *
 * Presence is read from `GET /api/telephony/presence` (the same route the
 * console uses) rather than from the routing document, because it changes while
 * the screen is open. Nothing here can disturb a call in progress: a manual
 * presence change is refused server-side during a call, and choosing a speaker
 * only calls `setSinkId` on the audio element.
 */

const TONE_CLASS = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-200 bg-amber-50 text-amber-950",
  info: "border-blue-200 bg-blue-50 text-blue-900",
  neutral: "border-zinc-200 bg-zinc-100 text-zinc-700",
} as const;

export type MyPhoneTestCall = (input: { to: string; lineId: string | null }) => Promise<void>;

const subscribeNothing = () => () => undefined;
const alwaysFalse = () => false;

export function MyPhonePanel({
  document,
  onSaved,
  onTestCall,
}: {
  document: RoutingDocument;
  onSaved: (response: RoutingConfigResponse) => void;
  /** Wired to the console's `dial`, so the browser answers its own leg. */
  onTestCall?: MyPhoneTestCall;
}) {
  const [profileId, setProfileId] = useState<string | null>(null);
  const [presence, setPresence] = useState<MyPresence | null>(null);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // `null` until the client store has a clock (server pass and hydration): the
  // countdown and the device verdict are withheld rather than computed against
  // epoch zero.
  const clock = useSecondClock();

  // --- presence --------------------------------------------------------------

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const result = await telephonyJson<MyPresenceResponse>("/api/telephony/presence", {
        label: "prezencia",
        signal: controller.signal,
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      }).catch(() => null);
      if (!result || controller.signal.aborted) return;
      if (result.status === 503) {
        setError(TELEPHONY_NOT_CONFIGURED_MESSAGE);
        return;
      }
      if (!result.ok || !result.body) {
        setError(result.body?.error ?? "Prezenciu sa nepodarilo načítať.");
        return;
      }
      setProfileId(result.body.snapshot?.actorProfileId ?? result.body.own?.profileId ?? null);
      setPresence(result.body.own ?? null);
      setError(null);
    })();
    return () => controller.abort();
  }, [reloadToken]);

  const changePresence = useCallback(async (body: Record<string, unknown>, url = "/api/telephony/presence") => {
    setPresenceBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await telephonyJson<MyPresenceResponse>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        label: "zmena dostupnosti",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      if (result.status === 503) {
        setError(TELEPHONY_NOT_CONFIGURED_MESSAGE);
        return;
      }
      if (!result.ok) {
        setError(result.body?.error ?? "Stav sa nepodarilo uložiť.");
        return;
      }
      if (result.body?.own) setPresence(result.body.own);
      else setReloadToken((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Stav sa nepodarilo uložiť.");
    } finally {
      setPresenceBusy(false);
    }
  }, []);

  const reasons = useMemo(() => activePauseReasons(document.pauseReasons), [document.pauseReasons]);
  const changeAllowed = canChangePresence(presence);
  const wrapUp = clock ? describeWrapUp(presence, clock) : null;

  // --- my settings -----------------------------------------------------------

  const operator = profileId ? findOperator(document.operators, profileId) : null;
  const [draft, setDraft] = useState<OperatorDraft | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  // The panel learns who it belongs to only after the presence answer, so the
  // draft is keyed on the operator row instead of being seeded in useState.
  const draftKey = operator ? `${operator.profileId}:${JSON.stringify(operator.settings)}` : null;
  const [draftKeyInState, setDraftKeyInState] = useState<string | null>(null);
  if (operator && draftKey !== draftKeyInState) {
    setDraftKeyInState(draftKey);
    setDraft(operatorDraft(operator));
  }

  async function saveMySettings() {
    if (!draft || !operator || settingsBusy) return;
    const patch = operatorPatch(draft, operator);
    if (Object.keys(patch).length === 0) return;
    setSettingsBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveOperatorSettings(operator.profileId, patch as Record<string, unknown>);
      // The settings route answers with the saved row only, so the panel above
      // gets a fresh document instead of a hand-patched one.
      onSaved(await loadRoutingConfig("ringGroups"));
      setNotice("Tvoje nastavenia telefónu sú uložené.");
    } catch (caught) {
      setError(caught instanceof ConfigRequestError ? caught.message : caught instanceof Error ? caught.message : "Nastavenia sa nepodarilo uložiť.");
    } finally {
      setSettingsBusy(false);
    }
  }

  // --- audio output ----------------------------------------------------------

  // Feature detection is browser state, not React state: read through a store so
  // the server pass renders the "not supported" branch and hydration agrees.
  const audioSupported = useSyncExternalStore(subscribeNothing, audioOutputSupported, alwaysFalse);
  const [audioOptions, setAudioOptions] = useState<AudioOutputOption[]>([]);
  const [audioDeviceId, setAudioDeviceId] = useState<string | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);

  const refreshAudioDevices = useCallback(async () => {
    const options = await listAudioOutputs().catch(() => []);
    setAudioOptions(options);
    setAudioDeviceId(readStoredAudioOutput());
  }, []);

  useEffect(() => {
    if (!audioSupported) return;
    let cancelled = false;
    void listAudioOutputs()
      .catch(() => [])
      .then((options) => {
        if (cancelled) return;
        setAudioOptions(options);
        setAudioDeviceId(readStoredAudioOutput());
      });
    return () => {
      cancelled = true;
    };
  }, [audioSupported]);

  async function chooseAudioOutput(deviceId: string) {
    setAudioBusy(true);
    setNotice(null);
    try {
      const applied = await applyAudioOutput(remoteAudioElement(), deviceId || null);
      storeAudioOutput(deviceId || null);
      setAudioDeviceId(deviceId || null);
      setNotice(
        applied
          ? "Zvuk hovorov ide odteraz do zvoleného zariadenia."
          : "Zariadenie je uložené. Uplatní sa, keď telefón v prehliadači nabehne.",
      );
    } finally {
      setAudioBusy(false);
    }
  }

  /** Chrome hides device names until the microphone permission is granted. */
  async function revealDeviceNames() {
    setAudioBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      stream?.getTracks().forEach((track) => track.stop());
      await refreshAudioDevices();
    } finally {
      setAudioBusy(false);
    }
  }

  // --- test call -------------------------------------------------------------

  const target = useMemo(() => testCallTarget(document, profileId), [document, profileId]);
  const [testNumber, setTestNumber] = useState("");
  const [testNumberTouched, setTestNumberTouched] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const effectiveTestNumber = testNumberTouched ? testNumber : target.number;
  const testCheck = checkTestCallNumber(effectiveTestNumber, { allowlist: document.settings?.destinationAllowlist ?? null, lines: document.lines });

  async function startTestCall() {
    if (!onTestCall || !testCheck.number || testBusy) return;
    if (typeof window !== "undefined" && !window.confirm(confirmTestCall(testCheck.number, testCheck.warning))) return;
    setTestBusy(true);
    setError(null);
    setNotice(null);
    try {
      await onTestCall({ to: testCheck.number, lineId: target.line?.id ?? null });
      setNotice("Skúšobný hovor je spustený. Najprv zazvoní tvoj telefón v prehliadači.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Skúšobný hovor sa nepodarilo spustiť.");
    } finally {
      setTestBusy(false);
    }
  }

  // --- render ----------------------------------------------------------------

  const device = operator && clock ? describeDevice(operator, clock) : null;
  const issues = draft ? validateOperatorDraft(draft, { lines: document.lines }) : [];
  const dirty = Boolean(draft && operator && operatorDirty(draft, operator));

  return (
    <section className="rounded-md border border-zinc-200 bg-white" aria-labelledby="my-phone-heading">
      <SettingsSectionHeader icon={Smartphone} title="Môj telefón" description="Tvoja dostupnosť, zvukové zariadenie a skúšobný hovor." />

      <div className="grid gap-4 p-4">
        <h3 id="my-phone-heading" className="sr-only">
          Môj telefón
        </h3>

        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}

        {/* Presence */}
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-zinc-950">Dostupnosť</span>
            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[presenceTone(presence?.status)]}`}>
              {presenceLabel(presence?.status)}
            </span>
          </div>

          <p className="text-xs text-zinc-600">{describePresence(presence, document.pauseReasons)}</p>
          {wrapUp && <p className="mt-1 text-xs font-semibold text-amber-700">{wrapUp}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={presenceBusy || !changeAllowed}
              onClick={() => void changePresence({ status: "available" })}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
            >
              {presenceBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <PhoneCall size={15} aria-hidden="true" />}
              Som dostupný
            </button>

            {reasons.map((reason) => (
              <button
                key={reason.id}
                type="button"
                disabled={presenceBusy || !changeAllowed}
                onClick={() => void changePresence({ status: "paused", pauseReasonId: reason.id })}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
              >
                <Coffee size={15} aria-hidden="true" />
                {describePauseReason(reason)}
              </button>
            ))}

            {reasons.length === 0 && (
              <button
                type="button"
                disabled={presenceBusy || !changeAllowed}
                onClick={() => void changePresence({ status: "paused" })}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
              >
                <Coffee size={15} aria-hidden="true" />
                Pauza
              </button>
            )}

            <button
              type="button"
              disabled={presenceBusy || !changeAllowed}
              onClick={() => void changePresence({ status: "offline" })}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
            >
              <PhoneOff size={15} aria-hidden="true" />
              Odhlásiť z telefónie
            </button>

            {canEndWrapUp(presence) && (
              <button
                type="button"
                disabled={presenceBusy}
                onClick={() => void changePresence({}, "/api/telephony/presence/end-wrap-up")}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:text-zinc-400"
              >
                Ukončiť dopisovanie
              </button>
            )}
          </div>

          {!changeAllowed && <p className="mt-2 text-xs text-amber-700">Stav sa nedá zmeniť počas hovoru.</p>}
          {device && <p className="mt-2 text-xs text-zinc-600">Telefón v prehliadači: {device.label.toLowerCase()} — {device.detail}</p>}
        </div>

        {/* Audio output */}
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Headphones size={16} aria-hidden="true" className="text-zinc-500" />
            <span className="text-sm font-semibold text-zinc-950">Zvukový výstup</span>
          </div>

          {!audioSupported ? (
            <SettingsNotice tone="info">
              Tento prehliadač neumožňuje vybrať reproduktor pre hovor. Zariadenie sa dá prepnúť v nastaveniach operačného systému.
            </SettingsNotice>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <SettingsField label="Kam ide zvuk hovoru" hint="Platí pre tento počítač a prehliadač.">
                <select
                  className={settingsInputClass}
                  disabled={audioBusy}
                  value={selectedAudioOutput(audioOptions, audioDeviceId)}
                  onChange={(event) => void chooseAudioOutput(event.target.value)}
                >
                  <option value="">— predvolené zariadenie systému —</option>
                  {audioOptions.map((option) => (
                    <option key={option.deviceId} value={option.deviceId}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </SettingsField>

              <div className="flex items-end">
                <button
                  type="button"
                  disabled={audioBusy}
                  onClick={() => void revealDeviceNames()}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
                >
                  {audioBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Headphones size={15} aria-hidden="true" />}
                  Načítať názvy zariadení
                </button>
              </div>
            </div>
          )}

          {audioSupported && audioOutputMissing(audioOptions, audioDeviceId) && (
            <p className="mt-2 text-xs text-amber-700">Naposledy zvolené zariadenie už nie je pripojené, zvuk ide do systémového predvoleného.</p>
          )}
        </div>

        {/* Test call */}
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <PhoneCall size={16} aria-hidden="true" className="text-zinc-500" />
            <span className="text-sm font-semibold text-zinc-950">Skúšobný hovor</span>
          </div>

          <p className="text-xs text-zinc-600">{target.note}</p>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <SettingsField label="Číslo na skúšku" hint="Skúšobný hovor je skutočný a je spoplatnený.">
              <input
                className={settingsInputClass}
                disabled={testBusy || !onTestCall}
                value={effectiveTestNumber}
                onChange={(event) => {
                  setTestNumberTouched(true);
                  setTestNumber(event.target.value);
                }}
                placeholder="+421900123456"
              />
            </SettingsField>

            <div className="flex items-end">
              <button
                type="button"
                disabled={testBusy || !onTestCall || !testCheck.number}
                onClick={() => void startTestCall()}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
              >
                {testBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <PhoneCall size={15} aria-hidden="true" />}
                Spustiť skúšobný hovor
              </button>
            </div>
          </div>

          {!onTestCall && <p className="mt-2 text-xs text-zinc-600">Skúšobný hovor sa dá spustiť z dispečerskej konzoly.</p>}
          {testCheck.error && effectiveTestNumber.trim() !== "" && <p className="mt-2 text-xs font-medium text-red-700">{testCheck.error}</p>}
          {testCheck.warning && <p className="mt-2 text-xs text-amber-700">{testCheck.warning}</p>}
        </div>

        {/* My own settings */}
        {draft && operator && (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Save size={16} aria-hidden="true" className="text-zinc-500" />
              <span className="text-sm font-semibold text-zinc-950">Moje nastavenia hovorov</span>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <SettingsField label="Odchádzajúca linka" hint="Číslo, ktoré uvidí volaný.">
                <select
                  className={settingsInputClass}
                  disabled={settingsBusy}
                  value={draft.defaultFromLineId ?? ""}
                  onChange={(event) => setDraft({ ...draft, defaultFromLineId: event.target.value || null })}
                >
                  <option value="">— systémové číslo organizácie —</option>
                  {activeLines(document.lines).map((line) => (
                    <option key={line.id} value={line.id}>
                      {describeLineOption(line)}
                    </option>
                  ))}
                </select>
              </SettingsField>

              <SettingsField label="Čas po hovore (s)" hint="Koľko sekúnd po zložení ti nezazvoní ďalší hovor.">
                <input
                  className={settingsInputClass}
                  disabled={settingsBusy}
                  type="number"
                  min={0}
                  max={600}
                  step={5}
                  value={draft.wrapUpSeconds}
                  onChange={(event) => setDraft({ ...draft, wrapUpSeconds: Number(event.target.value) })}
                />
              </SettingsField>
            </div>

            <SettingsIssueList issues={issues} />

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={settingsBusy || !dirty || issues.length > 0}
                onClick={() => void saveMySettings()}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
              >
                {settingsBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
                Uložiť moje nastavenia
              </button>
              {dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
