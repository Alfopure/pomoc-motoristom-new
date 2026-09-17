"use client";

import { CheckCircle2, Circle, CircleDot, PhoneOutgoing, Sparkles, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { TelephonyRequestTimeoutError } from "@/lib/telephony/client-request";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { aiDemoPollDelayMs } from "@/lib/telephony/poll-schedule";

import {
  AiDemoRequestError, loadAttempt, loadHistory, loadPreflight, startDemo, stopDemo,
  type AiDemoAttemptView, type AiDemoPreflight,
} from "./ai-demo-client";
import {
  AI_DEMO_CONTEXT_MAX_CHARS, AI_DEMO_SCENARIO_OPTIONS, describeGaps, describeLatency, isActive, operatorBadge,
  readinessMessages, scenarioLabel, startErrorMessage, stateLabel, timelineSteps, validateContext, validateTarget,
} from "./ai-demo-model";
import { SettingsField, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";

/**
 * The "AI" tab: one screen that starts a single demo call, shows where it is,
 * and ends it.
 *
 * Deliberately not a console. There is one button that costs money, it is
 * behind a checkbox and a confirmation, and the server decides everything —
 * this component cannot widen a single rule it displays. The readiness card
 * exists so a refusal is explained here rather than discovered on the phone.
 *
 * The timeline is the reason the tab exists at all: the demo is judged on how
 * fast Veronika speaks after the pickup, and those milliseconds are measured
 * server-side and shown here rather than guessed at by ear.
 */

const badgeTone = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  off: "border-zinc-200 bg-zinc-50 text-zinc-600",
} as const;

export function AiDemoPanel({ onNavigateToSettings }: { onNavigateToSettings?: () => void }) {
  const [preflight, setPreflight] = useState<AiDemoPreflight | null>(null);
  const [attempt, setAttempt] = useState<AiDemoAttemptView | null>(null);
  const [history, setHistory] = useState<AiDemoAttemptView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingRemote, setCheckingRemote] = useState(false);

  const [target, setTarget] = useState("");
  const [scenario, setScenario] = useState<string>(AI_DEMO_SCENARIO_OPTIONS[0].value);
  const [context, setContext] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const failures = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  // The attempt id the poller is following. Kept in a ref so the polling effect
  // does not restart every time a tick brings a new snapshot of the same call;
  // written from an effect, never during render.
  const followingId = useRef<string | null>(null);
  useEffect(() => {
    followingId.current = attempt && isActive(attempt) ? attempt.id : null;
  }, [attempt]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    const controller = new AbortController();

    const load = async () => {
      try {
        const next = await loadPreflight({ signal: controller.signal });
        if (cancelled) return;
        failures.current = 0;
        setPreflight(next);
        // The server is the authority on what is running: an attempt somebody
        // else started in another tab shows up here too.
        const active = next.db.activeAttempt;
        if (active) setAttempt(active);
        else if (followingId.current) {
          const finished = await loadAttempt(followingId.current, controller.signal);
          if (!cancelled) setAttempt(finished.attempt);
        }
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        failures.current += 1;
        if (!(caught instanceof TelephonyRequestTimeoutError)) {
          setError(caught instanceof AiDemoRequestError ? caught.message : "Stav AI dema sa nepodarilo načítať.");
        }
      }
    };

    let chain = 0;
    const schedule = (generation: number) => {
      if (cancelled || generation !== chain) return;
      timeoutId = window.setTimeout(async () => {
        await load();
        schedule(generation);
      }, aiDemoPollDelayMs({
        hasActiveAttempt: followingId.current !== null,
        documentHidden: document.visibilityState === "hidden",
        consecutiveFailures: failures.current,
      }));
    };

    const restart = () => {
      if (cancelled) return;
      chain += 1;
      const generation = chain;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      void load().then(() => schedule(generation));
    };

    const onVisibility = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      restart();
    };

    restart();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    loadHistory(10, controller.signal)
      .then((result) => setHistory(result.attempts))
      .catch(() => setHistory([]));
    return () => controller.abort();
  }, [reloadToken, attempt?.state]);

  if (!preflight) {
    return (
      <section className="grid gap-4">
        <SettingsSectionHeader
          icon={Sparkles}
          title="AI operátorka Veronika"
          description="Ukážka hovoru s umelou inteligenciou na neutrálnej linke. Len na testovanie, len pre administrátora."
        />
        <p className="text-sm text-zinc-600">Načítavam…</p>
      </section>
    );
  }

  const readiness = readinessMessages(preflight);
  const badge = operatorBadge(preflight);
  const blocking = readiness.some((entry) => entry.tone === "error");
  const switchesOff = !preflight.telnyx.liveCallsDb || !preflight.telnyx.liveCallsEnv;
  const targetCheck = target.trim().length > 0 ? validateTarget(target, preflight) : null;
  const contextIssue = validateContext(scenario, context);
  const running = isActive(attempt);
  const canCall = !blocking && !switchesOff && !running && confirmed && targetCheck?.ok === true && contextIssue === null && !busy;

  const onCall = async () => {
    if (!canCall || targetCheck?.ok !== true) return;
    const display = formatPhoneNumberForDisplay(targetCheck.e164);
    if (!window.confirm(`Uskutočniť skutočný spoplatnený hovor na ${display}?`)) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await startDemo({
        requestId: crypto.randomUUID(),
        to: targetCheck.e164,
        scenario,
        ...(context.trim().length > 0 ? { context: context.trim() } : {}),
      });
      setAttempt(result.attempt);
      setConfirmed(false);
      setNotice(result.reused ? "Táto požiadavka už bola spustená." : "Hovor sa vytáča.");
      reload();
    } catch (caught) {
      if (caught instanceof TelephonyRequestTimeoutError) {
        // The request may well have been applied. Never retry a billable call
        // on a timeout: reload and let the server say what happened.
        setError("Odpoveď neprišla v čase. Načítavam aktuálny stav — hovor mohol byť vytvorený.");
        reload();
      } else if (caught instanceof AiDemoRequestError) {
        setError(startErrorMessage(caught.code, caught.message));
      } else {
        setError("Hovor sa nepodarilo spustiť.");
      }
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    if (!attempt || !window.confirm("Ukončiť demo hovor?")) return;
    setBusy(true);
    try {
      const result = await stopDemo(attempt.id);
      setAttempt(result.attempt);
      setNotice("Demo ukončené.");
      reload();
    } catch (caught) {
      setError(caught instanceof AiDemoRequestError ? caught.message : "Demo sa nepodarilo ukončiť.");
    } finally {
      setBusy(false);
    }
  };

  const onCheckRemote = async () => {
    setCheckingRemote(true);
    try {
      setPreflight(await loadPreflight({ remote: true }));
      setNotice("Overené u poskytovateľov (iba čítanie).");
    } catch (caught) {
      setError(caught instanceof AiDemoRequestError ? caught.message : "Overenie u poskytovateľov sa nepodarilo.");
    } finally {
      setCheckingRemote(false);
    }
  };

  return (
    <section className="grid gap-4" aria-labelledby="ai-demo-heading">
      <div id="ai-demo-heading">
        <SettingsSectionHeader
          icon={Sparkles}
          title="AI operátorka Veronika"
          description="Ukážka hovoru s umelou inteligenciou na neutrálnej linke. Len na testovanie, len pre administrátora."
        />
      </div>

      {readiness.map((entry, index) => (
        <SettingsNotice key={`${entry.tone}-${index}`} tone={entry.tone}>
          {entry.message}
          {entry.action === "settings" && onNavigateToSettings && (
            <>
              {" "}
              <button type="button" onClick={onNavigateToSettings} className="font-semibold underline underline-offset-4">
                Otvoriť Bezpečnosť
              </button>
            </>
          )}
        </SettingsNotice>
      ))}
      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
      {notice && <SettingsNotice tone="info">{notice}</SettingsNotice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid gap-4">
          <article className="rounded-lg border border-zinc-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-zinc-950">Veronika</span>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${badgeTone[badge.tone]}`}>{badge.label}</span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">Virtuálna operátorka · demo</p>
            <p className="mt-2 text-sm text-zinc-700">
              Zavolá zákazníkovi z neutrálnej linky {preflight.fromNumber ? formatPhoneNumberForDisplay(preflight.fromNumber) : "—"}, predstaví sa ako
              Veronika z Pomoci motoristom a vybaví dohodnutý účel. Nie je členom plánov zvonenia a neprijíma hovory.
            </p>
            {preflight.model && (
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-zinc-500">
                <dt>Model</dt>
                <dd className="text-right text-zinc-700">{preflight.model.live}</dd>
                <dt>Hlas</dt>
                <dd className="text-right text-zinc-700">{preflight.model.voice}</dd>
                <dt>Max. dĺžka</dt>
                <dd className="text-right text-zinc-700">{preflight.limits?.maxCallSeconds ?? "—"} s</dd>
              </dl>
            )}
            <button
              type="button"
              onClick={onCheckRemote}
              disabled={checkingRemote}
              className="mt-3 inline-flex h-9 items-center rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
            >
              {checkingRemote ? "Overujem…" : "Overiť u poskytovateľov"}
            </button>
          </article>

          {attempt && (
            <article className="rounded-lg border border-zinc-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-zinc-950">Priebeh hovoru</h3>
              <p className="mt-1 text-xs text-zinc-500">
                {scenarioLabel(attempt.scenario)} · {attempt.targetMasked ?? "—"}
              </p>
              <ol className="mt-3 grid gap-1" role="status">
                {timelineSteps(attempt).map((step) => {
                  const Icon = step.done ? CheckCircle2 : step.current ? CircleDot : Circle;
                  return (
                    <li key={step.key} className="flex items-center justify-between gap-2 text-sm">
                      <span className={`inline-flex items-center gap-2 ${step.done ? "text-zinc-950" : "text-zinc-500"}`}>
                        <Icon size={14} aria-hidden="true" />
                        {step.label}
                      </span>
                      <span className="font-mono text-xs text-zinc-500">{step.at ? new Date(step.at).toLocaleTimeString("sk-SK", { hour12: false }) : "—"}</span>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-3 text-xs text-zinc-600">
                Stav: <span className="font-semibold text-zinc-900">{stateLabel(attempt.state)}</span>
                {describeLatency(attempt) && <> · {describeLatency(attempt)}</>}
                {describeGaps(attempt) && <> · {describeGaps(attempt)}</>}
              </p>
              {(attempt.endReason || attempt.errorCode) && (
                <p className="mt-1 font-mono text-xs text-zinc-500">
                  {attempt.errorCode ?? attempt.endReason}
                  {attempt.greetingStatus !== "none" && ` · pozdrav: ${attempt.greetingStatus}`}
                </p>
              )}
              <button
                type="button"
                onClick={onStop}
                disabled={busy || !running}
                className="mt-3 inline-flex h-10 items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                <Square size={14} aria-hidden="true" />
                Ukončiť
              </button>
            </article>
          )}
        </div>

        <form
          className="grid gap-3 rounded-lg border-2 border-red-200 bg-red-50/40 p-4"
          onSubmit={(submit) => {
            submit.preventDefault();
            void onCall();
          }}
        >
          <h3 className="text-sm font-semibold text-zinc-950">Skúšobný hovor</h3>

          <SettingsField label="Komu zavolať" hint="Slovenské číslo, napríklad 0910 988 882. Server povoľuje len čísla zo svojho zoznamu.">
            <input
              type="tel"
              value={target}
              onChange={(change) => setTarget(change.target.value)}
              className={settingsInputClass}
              autoComplete="off"
              placeholder="0910 988 882"
            />
          </SettingsField>
          {targetCheck && !targetCheck.ok && <SettingsNotice tone="warning">{targetCheck.message}</SettingsNotice>}

          <SettingsField label="Z linky">
            <input type="text" value={preflight.fromNumber ? formatPhoneNumberForDisplay(preflight.fromNumber) : "—"} readOnly disabled className={settingsInputClass} />
          </SettingsField>

          <SettingsField label="Účel hovoru">
            <select value={scenario} onChange={(change) => setScenario(change.target.value)} className={settingsInputClass}>
              {AI_DEMO_SCENARIO_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingsField>

          <SettingsField
            label="Kontext pre Veroniku (vymyslené údaje)"
            hint={`Napríklad meno zákazníka, značka auta, kedy má vrátiť náhradné vozidlo. Najviac ${AI_DEMO_CONTEXT_MAX_CHARS} znakov.`}
          >
            <textarea
              value={context}
              onChange={(change) => setContext(change.target.value)}
              maxLength={AI_DEMO_CONTEXT_MAX_CHARS}
              rows={3}
              className={`${settingsInputClass} h-auto py-2`}
              placeholder="Pán Novák, Škoda Octavia, náhradné vozidlo Fabia"
            />
          </SettingsField>
          {contextIssue && <SettingsNotice tone="warning">{contextIssue}</SettingsNotice>}

          <label className="flex items-start gap-2 text-sm text-zinc-800">
            <input type="checkbox" checked={confirmed} onChange={(change) => setConfirmed(change.target.checked)} className="mt-1" />
            Rozumiem, že sa uskutoční skutočný spoplatnený hovor na uvedené číslo.
          </label>

          <button
            type="submit"
            disabled={!canCall}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-yellow-400 bg-[#FCD703] px-4 text-sm font-semibold text-zinc-950 hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PhoneOutgoing size={16} aria-hidden="true" />
            {busy ? "Vytáčam…" : "Zavolať"}
          </button>
          {running && <p className="text-xs text-zinc-600">Jedno demo už beží. Najprv ho ukonči.</p>}
        </form>
      </div>

      {history.length > 0 && (
        <article className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-zinc-950">Posledné pokusy</h3>
          <ul className="mt-2 grid gap-2">
            {history.map((row) => (
              <li key={row.id} className="grid gap-0.5 border-b border-zinc-100 pb-2 text-sm last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-zinc-500">{new Date(row.timestamps.requestedAt).toLocaleString("sk-SK", { hour12: false })}</span>
                  <span className="text-xs font-semibold text-zinc-700">{stateLabel(row.state)}</span>
                </div>
                <div className="text-xs text-zinc-600">
                  {row.targetMasked ?? "—"} · {scenarioLabel(row.scenario)}
                </div>
                <div className="font-mono text-xs text-zinc-500">
                  {row.errorCode ?? row.endReason ?? "—"}
                  {describeLatency(row) && ` · ${describeLatency(row)}`}
                  {describeGaps(row) && ` · ${describeGaps(row)}`}
                </div>
              </li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}
