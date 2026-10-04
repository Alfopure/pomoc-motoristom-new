import type { IncomingFlow } from "./incoming-flow";

export type JourneyPhase = "received" | "greeting" | "ivr" | "routing" | "connecting" | "conversation" | "held" | "transfer" | "post_answer_wait" | "callback_confirmation" | "after_hours" | "ended" | "unknown";
export type JourneyEndpoint = {
  id: string; profileId: string | null; displayName: string | null;
  channel: "web" | "mobile_app" | "personal_number" | "external_number" | "application_unknown";
  number: string | null; state: string; reason: string | null;
  offeredAt: string | null; answeredAt: string | null; endedAt: string | null;
};
export type JourneyOccurrence = {
  id: string; executionIndex: number; sourceStepId: string | null;
  repeatStepId?: string; repeatRound?: number;
  kind: "ring" | "wait" | "ending"; label: string;
  state: "active" | "completed" | "skipped" | "pending" | "not_reached" | "unknown";
  startedAt: string | null; endedAt: string | null; configuredSeconds: number | null;
  timingBasis: "observed_transition" | "offer_interval" | "unknown";
  reason: string | null; endpoints: JourneyEndpoint[];
};
export type JourneyEvent = { id: string; at: string; kind: string; label: string; reason?: string };
export type CallJourney = {
  version: 1; sessionId: string; callId: string | null; lineId: string | null;
  direction: "inbound" | "outbound" | "internal";
  callerNumber: string | null; calledNumber: string | null;
  phase: JourneyPhase; sessionState: string; sessionVersion: number; asOf: string;
  customerActive: boolean; sessionActive: boolean;
  startedAt: string; answeredAt: string | null; endedAt: string | null;
  flow: { source: "incoming_flow" | "legacy" | "unknown"; signature: string | null };
  currentOccurrenceId: string | null;
  coverage: "complete" | "partial" | "unavailable"; truncated: boolean;
  occurrences: JourneyOccurrence[]; events: JourneyEvent[];
  callback: { kind: "requested" | "missed" | "manual" | "unknown"; requestedAt: string | null; digit: string | null } | null;
};
export type CallJourneysResponse = { ok: true; checkedAt: string; calls: CallJourney[]; truncated: boolean };
export type CallJourneyResponse = { ok: true; journey: CallJourney };

/** UI revision comparison only; never authorization or provider identity. */
export function incomingFlowSignature(flow: IncomingFlow): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  const text = canonical(flow);
  let a = 2166136261, b = 3339675911;
  for (let index = 0; index < text.length; index++) {
    a = Math.imul(a ^ text.charCodeAt(index), 16777619);
    b = Math.imul(b ^ text.charCodeAt(index), 2246822519);
  }
  return `flow1-${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

export const JOURNEY_PHASE_LABELS: Record<JourneyPhase, string> = {
  received: "Prichádzajúci hovor", greeting: "Úvodné hlásenie", ivr: "Výber na klávesnici", routing: "Smerovanie hovoru",
  connecting: "Spájame hovor", conversation: "Prebieha rozhovor", held: "Podržaný počas rozhovoru", transfer: "Prepájanie hovoru",
  post_answer_wait: "Čaká po prijatí", callback_confirmation: "Spätné volanie vyžiadané", after_hours: "Mimo otváracích hodín", ended: "Hovor skončil", unknown: "Stav neznámy",
};

export function journeyElapsedSeconds(startedAt: string | null, endedAt: string | null, now: number): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt), end = endedAt ? Date.parse(endedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.floor((end - start) / 1000) : null;
}
