import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";

import type { AiDemoAttemptView, AiDemoPreflight } from "./ai-demo-client";

/**
 * Pure view logic for the AI tab.
 *
 * Every rule here is a copy of a server rule, and that is deliberate: the
 * client repeats the checks so an admin sees the problem before the call is
 * placed, and the server repeats them because the client is not an authority.
 */

export const AI_DEMO_SCENARIO_OPTIONS = [
  { value: "replacement_vehicle_return", label: "Auto je opravené – dohodnúť vrátenie náhradného vozidla" },
  { value: "repair_status", label: "Informovať o stave opravy" },
  { value: "appointment_reminder", label: "Pripomenúť dohodnutý termín" },
  { value: "custom", label: "Vlastný účel (zadaj kontext)" },
] as const;

export const AI_DEMO_CONTEXT_MAX_CHARS = 300;

/**
 * How the voices are presented.
 *
 * The API exposes no speed or style parameter, so the only levers on how human
 * she sounds are the prompt and this list. The documented table marks each
 * voice as recorded ("Natural") or synthesised ("Generated"), and the regional
 * note describes speaking *style*, not accent — none of the voices is Slovak.
 */
const VOICE_LABELS: Record<string, string> = {
  gleam: "Gleam — ženský, nahrávaný (predvolený)",
  willow: "Willow — ženský, nahrávaný",
  bossa: "Bossa — ženský, nahrávaný",
  meridian: "Meridian — mužský, nahrávaný",
  vesper: "Vesper — mužský, nahrávaný",
  stone: "Stone — mužský, nahrávaný",
  ripple: "Ripple — mužský, nahrávaný",
  tempo: "Tempo — mužský, nahrávaný",
  marin: "Marin — predvolený hlas OpenAI",
  cedar: "Cedar",
  sage: "Sage",
  quartz: "Quartz — ženský, syntetický",
  delta: "Delta — ženský, syntetický",
  beacon: "Beacon — mužský, syntetický",
  cinder: "Cinder — mužský, syntetický",
};

export function voiceLabel(voice: string): string {
  return VOICE_LABELS[voice] ?? voice;
}

/** Recorded voices first: they are the ones that do not sound like a machine. */
export function voiceOptions(preflight: AiDemoPreflight): Array<{ value: string; label: string }> {
  const all = preflight.voices?.all ?? [];
  const natural = new Set(preflight.voices?.natural ?? []);
  const known = all.filter((voice) => voice in VOICE_LABELS);
  return [...known.filter((v) => natural.has(v)), ...known.filter((v) => !natural.has(v))]
    .map((value) => ({ value, label: voiceLabel(value) }));
}

export type TimelineStep = { key: string; label: string; at: string | null; done: boolean; current: boolean };

const STEP_ORDER: Array<{ key: keyof AiDemoAttemptView["timestamps"]; label: string; states: string[] }> = [
  { key: "requestedAt", label: "Požiadavka prijatá", states: ["requested"] },
  { key: "sipDialedAt", label: "Vytáčam AI", states: ["sip_dialing"] },
  { key: "aiAcceptedAt", label: "AI prijala hovor", states: ["ai_offered", "ai_accepted"] },
  { key: "mobileDialedAt", label: "Vytáčam zákazníka", states: ["mobile_dialing"] },
  { key: "bridgedAt", label: "Spojené", states: ["bridged"] },
  { key: "firstTranscriptAt", label: "Veronika hovorí", states: ["talking"] },
  { key: "endedAt", label: "Ukončené", states: ["ending", "ended", "failed"] },
];

/** The state order, used to decide what is already behind us. */
const STATE_RANK: Record<string, number> = {
  requested: 0, sip_dialing: 1, ai_offered: 2, ai_accepted: 2, mobile_dialing: 3,
  bridged: 4, talking: 5, ending: 6, ended: 7, failed: 7,
};

export function timelineSteps(attempt: AiDemoAttemptView): TimelineStep[] {
  const rank = STATE_RANK[attempt.state] ?? 0;
  return STEP_ORDER.map((step) => {
    const at = attempt.timestamps[step.key];
    const stepRank = Math.min(...step.states.map((state) => STATE_RANK[state] ?? 0));
    // A step counts as done when it has a timestamp *or* the call has already
    // moved past it: a lost webhook must not leave the timeline stuck at a
    // stage the row itself says is over.
    return { key: step.key, label: step.label, at, done: at !== null || stepRank < rank, current: step.states.includes(attempt.state) };
  });
}

export type Readiness = { tone: "success" | "warning" | "error"; message: string; action?: "settings" };

/**
 * What the readiness card says, in the order an operator can act on.
 *
 * Configuration first (nothing works without it), then the switches (which the
 * admin can flip themselves), then the advisory notes.
 */
export function readinessMessages(preflight: AiDemoPreflight): Readiness[] {
  const messages: Readiness[] = [];

  if (!preflight.enabled) {
    messages.push({ tone: "error", message: "AI demo nie je v tomto prostredí zapnuté (AI_DEMO_ENABLED)." });
  }
  if (!preflight.configured) {
    messages.push({ tone: "error", message: `Chýba serverová konfigurácia: ${preflight.missing.join(", ")}.` });
  }
  if (!preflight.db.migrationApplied) {
    messages.push({ tone: "error", message: "Databázová migrácia AI dema nie je aplikovaná." });
  }
  if (!preflight.fromLineActive && preflight.fromNumber) {
    messages.push({ tone: "error", message: `Odchádzajúca linka ${preflight.fromNumber} nie je aktívna v tejto organizácii.` });
  }
  if (!preflight.webSocketGlobal) {
    messages.push({ tone: "warning", message: `Toto prostredie nemá WebSocket (${preflight.node}) — Veronika sa neozve prvá.` });
  }
  if (!preflight.telnyx.liveCallsEnv || !preflight.telnyx.liveCallsDb) {
    messages.push({ tone: "warning", message: "Živé hovory sú vypnuté. Bez nich sa hovor nevytočí.", action: "settings" });
  }
  if (preflight.remote?.models.liveAvailable === false) {
    messages.push({
      tone: "warning",
      message: preflight.remote.models.error
        ? `OpenAI sa nepodarilo overiť (${preflight.remote.models.error}).`
        : "OpenAI kľúč nevidí model gpt-live-1.",
    });
  }
  if (preflight.remote?.did.onThisApp === false) {
    messages.push({ tone: "warning", message: "Číslo je na inej Call Control aplikácii. Odchádzajúci hovor môže Telnyx odmietnuť." });
  }

  if (messages.length === 0) {
    const limit = preflight.limits?.maxAttemptsPerDay ?? 0;
    const count = limit > 0 ? `dnes ${preflight.db.attemptsToday}/${limit} pokusov` : `dnes ${preflight.db.attemptsToday} pokusov, bez denného limitu`;
    messages.push({ tone: "success", message: `Pripravené · linka ${preflight.fromNumber ?? "—"} · ${count}` });
  }
  return messages;
}

export type OperatorBadge = { tone: "ok" | "warn" | "off"; label: string };

export function operatorBadge(preflight: AiDemoPreflight): OperatorBadge {
  if (preflight.db.activeAttempt && !["ended", "failed"].includes(preflight.db.activeAttempt.state)) return { tone: "warn", label: "Telefonuje" };
  if (!preflight.enabled || !preflight.configured || !preflight.db.migrationApplied) return { tone: "off", label: "Vypnutá" };
  if (!preflight.telnyx.liveCallsDb || !preflight.telnyx.liveCallsEnv) return { tone: "off", label: "Živé hovory vypnuté" };
  return { tone: "ok", label: "Pripravená" };
}

export type TargetValidation = { ok: true; e164: string } | { ok: false; message: string };

/** The same three checks the server makes, so the button can explain itself. */
export function validateTarget(raw: string, preflight: AiDemoPreflight): TargetValidation {
  const e164 = normalizeE164(raw, { defaultCountryCode: "421" });
  if (e164 === null || !/^\+[1-9]\d{6,14}$/.test(e164)) return { ok: false, message: "Zadaj platné telefónne číslo, napríklad 0910 988 882." };
  if (preflight.fromNumber && e164 === preflight.fromNumber) return { ok: false, message: "Toto je naša vlastná linka. Zadaj mobilné číslo." };
  if (!isDestinationAllowed(e164, preflight.telnyx.destinationAllowlist)) return { ok: false, message: "Toto číslo nie je v povolených cieľoch organizácie." };
  return { ok: true, e164 };
}

export function validateContext(scenario: string, context: string): string | null {
  if (scenario !== "custom") return null;
  return context.trim().length >= 10 ? null : "Pri vlastnom účele doplň kontext (aspoň 10 znakov).";
}

/** Slovak text for the error codes the start route can answer with. */
export function startErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case "ai_demo_disabled":
      return "AI demo nie je v tomto prostredí zapnuté.";
    case "ai_demo_not_configured":
      return "AI demo nie je nakonfigurované. Doplň serverové premenné.";
    case "ai_demo_migration_missing":
      return "Databázová migrácia AI dema nie je aplikovaná.";
    case "live_calls_disabled":
      return "Živé hovory sú vypnuté (kill switch). Zapni ich v Bezpečnosti.";
    case "destination_not_allowed":
      return "Toto číslo nie je v povolených cieľoch organizácie.";
    case "ai_demo_recipient_not_allowed":
      return "Toto číslo nie je v serverovom zozname povolených príjemcov dema.";
    case "ai_demo_target_is_own_line":
      return "Toto je naša vlastná linka. Zadaj mobilné číslo.";
    case "ai_demo_busy":
      return "Jedno demo už beží. Najprv ho ukonči.";
    case "ai_demo_daily_limit":
      return "Denný limit demo hovorov je vyčerpaný.";
    case "ai_demo_from_invalid":
      return "Odchádzajúca linka dema nie je aktívna v tejto organizácii.";
    case "ai_demo_context_required":
      return "Pri vlastnom účele doplň kontext (aspoň 10 znakov).";
    case "invalid_number":
      return "Telefónne číslo nie je platné.";
    default:
      return fallback;
  }
}

export function isActive(attempt: AiDemoAttemptView | null): boolean {
  return attempt !== null && !["ended", "failed"].includes(attempt.state);
}

export function formatClock(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("sk-SK", { hour12: false });
}

/**
 * The headline latency number: how long after the bridge she said her first
 * word. Anything above a couple of seconds is what the caller experiences as
 * "is anybody there?".
 */
export function describeLatency(attempt: AiDemoAttemptView): string | null {
  const firstWord = attempt.latency?.first_word_ms;
  if (typeof firstWord !== "number") return null;
  return `prvé slovo ${(firstWord / 1000).toFixed(1)} s po zdvihnutí`;
}

export function describeGaps(attempt: AiDemoAttemptView): string | null {
  const gaps = attempt.latency?.response_gaps_ms;
  if (!Array.isArray(gaps) || gaps.length === 0) return null;
  const average = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  return `odozva ${(average / 1000).toFixed(1)} s (${gaps.length}×)`;
}

export function scenarioLabel(scenario: string): string {
  return AI_DEMO_SCENARIO_OPTIONS.find((option) => option.value === scenario)?.label ?? scenario;
}

/** Slovak labels for the state machine, for the timeline footer and history. */
export function stateLabel(state: string): string {
  switch (state) {
    case "requested": return "Požiadavka";
    case "sip_dialing": return "Vytáčam AI";
    case "ai_offered": return "AI zvoní";
    case "ai_accepted": return "AI prijala";
    case "mobile_dialing": return "Zvoní zákazníkovi";
    case "bridged": return "Spojené";
    case "talking": return "Rozhovor";
    case "ending": return "Ukončujem";
    case "ended": return "Ukončené";
    case "failed": return "Zlyhalo";
    default: return state;
  }
}
