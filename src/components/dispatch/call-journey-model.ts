import { JOURNEY_PHASE_LABELS, journeyElapsedSeconds, type CallJourney, type JourneyEndpoint, type JourneyOccurrence } from "@/lib/telephony/call-journey";

export const JOURNEY_STALE_MS = 20_000;

/** A customer hangup alone is not terminal: provider cleanup may still be running. */
export function journeyTerminalKey(journey: CallJourney): string | null {
  if (journey.sessionActive || journey.customerActive || !["ended", "failed"].includes(journey.sessionState)
    || !journey.endedAt || !Number.isFinite(Date.parse(journey.endedAt))) return null;
  // asOf advances on every read, even when all recorded evidence is unchanged.
  const { asOf: _asOf, ...evidence } = journey;
  return JSON.stringify(evidence);
}

/** Wall clocks on the dispatcher device do not change the server's timeline. */
export function journeyDisplayNow(journey: Pick<CallJourney, "asOf">, observedAt: number | null, now: number, stale: boolean): number {
  const server = Date.parse(journey.asOf);
  if (!Number.isFinite(server)) return now;
  return server + (!stale && observedAt !== null ? Math.max(0, now - observedAt) : 0);
}

export function journeyTimer(seconds: number | null): string {
  if (seconds === null) return "—";
  const rounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(rounded / 60).toString().padStart(2, "0")}:${(rounded % 60).toString().padStart(2, "0")}`;
}

export function currentJourneyOccurrence(journey: CallJourney): JourneyOccurrence | null {
  return journey.occurrences.find(occurrence => occurrence.id === journey.currentOccurrenceId) ?? null;
}

export function journeyStageLabel(journey: CallJourney): string {
  const current = currentJourneyOccurrence(journey);
  if (current?.reason === "capacity" && journey.phase === "routing") return "Čaká na kapacitu";
  if (current && journey.phase === "routing") return current.label;
  return JOURNEY_PHASE_LABELS[journey.phase];
}

export function occurrenceElapsed(occurrence: JourneyOccurrence, now: number): number | null {
  // Unclosed historical intervals are missing evidence, not a running clock.
  if (occurrence.state !== "active" && !occurrence.endedAt) return null;
  return journeyElapsedSeconds(occurrence.startedAt, occurrence.endedAt, now);
}

export const ENDPOINT_CHANNELS: Record<JourneyEndpoint["channel"], string> = {
  web: "Aplikácia · web", mobile_app: "Aplikácia · mobil", personal_number: "Osobné číslo",
  external_number: "Záložné číslo", application_unknown: "Aplikácia",
};

const REASONS: Record<string, string> = {
  manual_pickup: "Prijaté ručne",
  answered_elsewhere: "Zastavené po prijatí na inom zariadení", no_answer: "Bez prijatia", cancelled: "Pokus zastavený",
  failed: "Pokus sa nepodaril", busy: "Obsadené", no_eligible_members: "Žiadny príjemca nebol dostupný",
  all_offers_finished: "Všetky pokusy sa skončili", ordered_exhausted: "Postupné pokusy sa skončili",
  no_presence: "Stav operátora nie je dostupný", offline: "Operátor je offline", paused: "Operátor má prestávku",
  ringing: "Operátor už dostáva iný hovor", on_call: "Operátor telefonuje", wrap_up: "Operátor dokončuje predchádzajúci hovor",
  no_device: "Aplikácia nie je pripojená", device_stale: "Pripojenie aplikácie nie je aktuálne", open_offer: "Operátor už dostáva iný hovor",
  attempted: "Zariadenie už bolo v tomto kroku volané", duplicate: "Opakovaný cieľ bol vynechaný", capacity: "Dosiahnutá kapacita súčasných hovorov",
  fanout: "Dosiahnutý limit súčasného zvonenia", feature_disabled: "Volanie na tento cieľ nie je aktivované",
  step_timeout: "Uplynul čas na prijatie", flow_wait_timeout: "Uplynul čas čakania", callback_requested: "Volajúci požiadal o spätné volanie",
  caller_hangup: "Volajúci ukončil hovor", answered: "Hovor bol prijatý", skipped_offline: "Operátor alebo aplikácia neboli dostupní",
  wait_timeout: "Uplynul čas čakania", customer_hangup: "Volajúci ukončil hovor", completed: "Pokračovanie ďalším krokom", exhausted: "Postup zvonenia sa skončil",
  bridge_failed: "Hovor sa nepodarilo spojiť", operator_deferred: "Operátor posunul hovor do čakárne", transfer_failed: "Hovor sa nepodarilo prepojiť",
};
export function journeyReason(reason: string | null | undefined): string | null {
  return reason ? REASONS[reason] ?? "Dôvod nebol zaznamenaný" : null;
}

export function endpointStateLabel(endpoint: JourneyEndpoint, journey: CallJourney): string {
  if ((endpoint.state === "cancelled" || endpoint.state === "canceled") && endpoint.reason === "answered_elsewhere") return REASONS.answered_elsewhere;
  if (endpoint.reason && REASONS[endpoint.reason]) return REASONS[endpoint.reason];
  if (endpoint.state === "answered" || endpoint.state === "accepted") return "Prijaté";
  if (endpoint.state === "cancelled" || endpoint.state === "canceled") return journey.answeredAt ? "Zastavené po prijatí hovoru" : "Pokus zastavený";
  if (endpoint.state === "offered" || endpoint.state === "ringing") return "Pokus o spojenie";
  if (endpoint.state === "timeout" || endpoint.state === "no_answer" || endpoint.state === "timed_out") return "Bez prijatia";
  if (endpoint.state === "busy") return "Obsadené";
  if (endpoint.state === "failed") return "Pokus sa nepodaril";
  if (endpoint.state === "skipped_offline") return "Operátor alebo aplikácia neboli dostupní";
  if (endpoint.state === "skipped") return "Vynechané";
  return "Výsledok nezaznamenaný";
}

export function endpointAttemptSeconds(endpoint: JourneyEndpoint, active: boolean, now: number): number | null {
  const running = active && ["offered", "ringing"].includes(endpoint.state);
  const end = endpoint.answeredAt ?? endpoint.endedAt;
  return !end && !running ? null : journeyElapsedSeconds(endpoint.offeredAt, end, now);
}

/** No signature means no evidence that two frozen paths share a layout. */
export function journeyRouteGroups(calls: readonly CallJourney[]): { key: string; signature: string | null; calls: CallJourney[] }[] {
  const groups = new Map<string, { key: string; signature: string | null; calls: CallJourney[] }>();
  for (const call of calls) {
    const key = call.flow.signature ?? `session:${call.sessionId}`;
    const group = groups.get(key) ?? { key, signature: call.flow.signature, calls: [] };
    group.calls.push(call); groups.set(key, group);
  }
  return [...groups.values()];
}
