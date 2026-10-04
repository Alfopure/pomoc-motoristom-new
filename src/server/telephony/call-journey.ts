import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { CallJourney, JourneyEndpoint, JourneyEvent, JourneyOccurrence, JourneyPhase } from "@/lib/telephony/call-journey";
import { JOURNEY_PHASE_LABELS } from "@/lib/telephony/call-journey";
import { callbackOrigin } from "@/lib/telephony/callback-origin";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";
import { ACTIVE_SESSION_STATES, readMeta, type AttemptRow, type LegRow, type SessionRow } from "./state/types";

type Admin = SupabaseClient<Database>;
type CallRow = Database["public"]["Tables"]["motorist_calls"]["Row"];
type EventRow = Pick<Database["public"]["Tables"]["motorist_call_events"]["Row"], "id" | "normalized_payload" | "received_at" | "provider_timestamp" | "handled_status">;
type CallbackRow = Pick<Database["public"]["Tables"]["motorist_callback_requests"]["Row"], "source" | "metadata">;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const safeText = (value: unknown, limit = 160): string | null => typeof value === "string" && value.trim() && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const stamp = (value: unknown): string | null => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const first = (values: Array<string | null>): string | null => values.filter((value): value is string => value !== null).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
const last = (values: Array<string | null>): string | null => values.filter((value): value is string => value !== null).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
const safeReason = (value: unknown): string | null => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
const uuid = (value: unknown): value is string => typeof value === "string" && isUuid(value);
const phone = (value: unknown): string | null => typeof value === "string" ? normalizeE164(value) : null;
const STATES: Record<string, JourneyPhase> = { received: "received", greeting: "greeting", ivr: "ivr", ringing: "routing", waiting: "routing", parked: "post_answer_wait", talking: "conversation", held: "held", consulting: "transfer", conference: "conversation", after_hours: "after_hours", callback_offered: "routing", wrap_up: "ended", missed: "ended", failed: "ended", ended: "ended" };
const phaseForState = (value: unknown): JourneyPhase | undefined => typeof value === "string" && Object.hasOwn(STATES, value) ? STATES[value] : undefined;
const terminal = (state: string) => ["ended", "failed"].includes(state);

export type JourneyProjectionInput = {
  session: SessionRow; call: (Pick<CallRow, "id" | "end_reason"> & Partial<Pick<CallRow, "ended_at">>) | null;
  attempts: AttemptRow[]; legs: LegRow[]; events: EventRow[];
  profiles: Map<string, string>; callback?: CallbackRow | null; now: Date; truncated?: boolean;
};

/** Closed read projection: no provider IDs, credentials or arbitrary audit payloads. */
export function projectCallJourney(input: JourneyProjectionInput): CallJourney {
  const { session } = input;
  const meta = readMeta(session), ring = record(meta.ring), waiting = record(meta.waiting), plan = record(ring.plan);
  const steps = array(plan.steps).slice(0, 100).map(record);
  const evidence = record(meta.journey);
  const entries = array(evidence.entries).slice(0, 512).map(record).filter(row => stamp(row.at) && safeText(row.id) && ["step_enter", "step_exit", "phase"].includes(String(row.kind)));
  const callback = callbackOrigin(input.callback?.source ?? "unknown", input.callback?.metadata ?? {}, session.metadata);
  const callbackConfirmed = callback.kind === "requested";
  const scopedLegs = input.legs.filter(leg => leg.session_id === session.id && leg.organization_id === session.organization_id);
  const customer = scopedLegs.find(leg => leg.id === session.customer_leg_id) ?? scopedLegs.find(leg => leg.role === "customer");
  const closingPending = Boolean(meta.closing_message || ring.exhausted === true && ring.fallback === "hangup_message");
  const sessionActive = !session.ended_at && !terminal(session.state) && (session.state !== "missed" || closingPending);
  const customerEnded = stamp(customer?.ended_at) ?? stamp(input.call?.ended_at) ?? stamp(meta.customer_gone_at) ?? stamp(session.ended_at);
  const customerActive = sessionActive && customerEnded === null;
  let phase = phaseForState(session.state) ?? "unknown";
  if (!customerActive) phase = "ended";
  else if (callbackConfirmed) phase = "callback_confirmation";
  else if (!session.answered_at && closingPending && session.state === "missed") phase = "routing";
  else if (session.state === "waiting" && session.answered_at) phase = "post_answer_wait";
  else if (session.state === "ringing" && ["transfer", "consult"].includes(String(ring.mode))) phase = "transfer";
  else if (session.state === "talking" && record(meta.recording).pendingAudio) phase = "connecting";
  const activeIndex = phase === "routing" && !callbackConfirmed && session.direction === "inbound"
    ? session.state === "waiting" ? number(waiting.flow_step_index) : session.state === "ringing" && ring.mode === "plan" ? number(ring.active_step) : null
    : null;
  const diagnostics = input.events.flatMap(event => {
    const payload = record(event.normalized_payload);
    if (payload.session_id !== session.id || event.handled_status === "ignored") return [];
    return array(payload.routing).slice(0, 32).map(record).filter(item => item.version === 1 && stamp(item.at));
  });
  const occurrenceId = (index: number) => `${session.id}:${index}`;
  const validAttempts = input.attempts.filter(attempt => attempt.session_id === session.id && attempt.organization_id === session.organization_id);
  const validLegs = scopedLegs;
  const legs = new Map(validLegs.map(leg => [leg.id, leg]));
  const furthestObserved = Math.max(activeIndex ?? -1, ...validAttempts.map(attempt => attempt.step_index), ...entries.map(entry => number(entry.stepIndex) ?? -1), ...diagnostics.map(item => number(item.step) ?? -1));
  let missingTiming = false;
  const occurrences: JourneyOccurrence[] = session.direction === "inbound" ? steps.map((step, index) => {
    const attempts = validAttempts.filter(attempt => attempt.step_index === index);
    const localEntries = entries.filter(entry => entry.stepIndex === index);
    const entered = localEntries.find(entry => entry.kind === "step_enter");
    const exited = [...localEntries].reverse().find(entry => entry.kind === "step_exit");
    const selections = diagnostics.filter(item => item.step === index && item.kind === "selection");
    const completed = diagnostics.filter(item => item.step === index && item.kind === "completed").at(-1);
    const offered = first(attempts.map(attempt => stamp(attempt.offered_at)));
    const selected = selections.some(item => Number(item.selectedCount) > 0);
    const skipped = attempts.length === 0 && (exited?.reason === "no_eligible_members" || selections.length > 0 && !selected);
    const isActive = index === activeIndex;
    const kind = step.kind === "wait" ? "wait" as const : "ring" as const;
    const startedAt = stamp(entered?.at) ?? (isActive ? stamp(kind === "wait" ? waiting.since : ring.step_started_at) : null) ?? offered;
    const answeredAt = first(attempts.map(attempt => stamp(attempt.answered_at)));
    const attemptsFinished = attempts.length > 0 && attempts.every(attempt => !["offered", "pending"].includes(attempt.result));
    const endedAt = stamp(exited?.at) ?? answeredAt ?? (attemptsFinished ? last(attempts.map(attempt => stamp(attempt.ended_at))) : null) ?? stamp(completed?.at);
    const reached = Boolean(entered || exited || attempts.length || selections.length);
    const finishedRouting = !customerActive || Boolean(session.answered_at) || callbackConfirmed;
    const inferredPassed = !reached && index < furthestObserved;
    const state = isActive ? "active" : skipped ? "skipped" : reached && endedAt ? "completed" : reached || inferredPassed ? "unknown" : finishedRouting ? "not_reached" : "pending";
    // Missing old wait boundaries cannot be reconstructed from present-day settings.
    if (inferredPassed || reached && !startedAt || reached && !isActive && !endedAt || startedAt && endedAt && Date.parse(endedAt) < Date.parse(startedAt)) missingTiming = true;
    const endpoints: JourneyEndpoint[] = attempts.map(attempt => {
      const leg = attempt.leg_id ? legs.get(attempt.leg_id) : undefined;
      const winner = attempts.some(other => other.id !== attempt.id && other.result === "answered" && stamp(other.answered_at) && stamp(attempt.ended_at) && Date.parse(attempt.ended_at!) >= Date.parse(other.answered_at!));
      const cause = safeReason(leg?.hangup_cause);
      const cancelledByWinner = attempt.result === "cancelled" && winner && (!cause || ["lose_race", "normal_clearing"].includes(cause));
      return { id: attempt.id, profileId: attempt.profile_id, displayName: attempt.profile_id ? safeText(input.profiles.get(attempt.profile_id)) : null,
        channel: attempt.member_kind === "external_number" ? attempt.profile_id ? "personal_number" : "external_number" : attempt.application_device === "mobile" ? "mobile_app" : "web",
        number: attempt.member_kind === "external_number" ? phone(attempt.external_number) : null,
        state: attempt.result, reason: cancelledByWinner ? "answered_elsewhere" : cause ?? safeReason(attempt.result),
        offeredAt: stamp(attempt.offered_at), answeredAt: stamp(attempt.answered_at), endedAt: stamp(attempt.ended_at) };
    });
    // Explicit pickup has no ring-attempt row. Correlate only by its observed
    // initiation inside a known step interval; never guess an old wait boundary.
    if (startedAt && (endedAt || isActive)) for (const leg of validLegs) {
      const client = record(leg.client_state), initiated = stamp(leg.initiated_at);
      if (client.intent !== "pickup" || leg.role !== "operator" || !initiated || Date.parse(initiated) < Date.parse(startedAt) || endedAt && Date.parse(initiated) >= Date.parse(endedAt) || attempts.some(attempt => attempt.leg_id === leg.id)) continue;
      const cause = safeReason(leg.hangup_cause), answered = stamp(leg.answered_at);
      const accepted = answered && (!endedAt || Date.parse(answered) <= Date.parse(endedAt)) && !["late_answer", "operator_busy", "flow_wait_timeout"].includes(cause ?? "");
      endpoints.push({ id: `pickup:${leg.id}`, profileId: leg.profile_id, displayName: leg.profile_id ? safeText(input.profiles.get(leg.profile_id)) : null,
        channel: client.applicationDevice === "mobile" ? "mobile_app" : "application_unknown", number: null,
        state: accepted ? "answered" : leg.ended_at ? "cancelled" : "offered", reason: accepted ? "manual_pickup" : cause ?? "manual_pickup",
        offeredAt: initiated, answeredAt: accepted ? answered : null, endedAt: stamp(leg.ended_at) });
    }
    // Selection/skip evidence supplements actual offers, never substitutes for them.
    for (const decision of selections) for (const raw of array(decision.members).slice(0, 64)) {
      const member = record(raw), profileId = uuid(member.profileId) ? member.profileId : null;
      if (member.outcome !== "skipped" || !profileId) continue;
      const channel = member.endpoint === "pstn" ? "personal_number" as const : member.applicationDevice === "web" ? "web" as const : member.applicationDevice === "mobile" ? "mobile_app" as const : "application_unknown" as const;
      if (endpoints.some(endpoint => endpoint.profileId === profileId && (endpoint.channel === channel || channel === "application_unknown" && ["web", "mobile_app"].includes(endpoint.channel)))) continue;
      endpoints.push({ id: `${occurrenceId(index)}:skip:${profileId}:${channel}`, profileId, displayName: safeText(input.profiles.get(profileId)), channel, number: null,
        state: "skipped", reason: safeReason(member.reason), offeredAt: null, answeredAt: null, endedAt: null });
    }
    return { id: occurrenceId(index), executionIndex: index, sourceStepId: uuid(step.sourceId) ? step.sourceId : null,
      ...(uuid(step.repeatStepId) ? { repeatStepId: step.repeatStepId } : {}), ...(number(step.repeatRound) !== null ? { repeatRound: number(step.repeatRound)! } : {}),
      kind, label: kind === "wait" ? "Čakáreň" : safeText(step.groupName) ?? "Zvoní operátorom", state,
      startedAt, endedAt, configuredSeconds: kind === "wait" ? (number(step.waitMinutes) ?? 0) * 60 || null : number(step.timeoutSecs),
      timingBasis: entered ? "observed_transition" : offered ? "offer_interval" : "unknown",
      reason: isActive && stamp(ring.capacity_wait_since) && kind === "ring" ? "capacity" : safeReason(exited?.reason) ?? safeReason(completed?.reason) ?? (skipped ? "no_eligible_members" : null), endpoints };
  }) : [];
  const endingKind = safeReason(record(plan.fallback).kind);
  const endingEvent = diagnostics.find(item => item.kind === "fallback");
  const endingReached = Boolean(endingEvent || ring.exhausted === true && ring.fallback === endingKind);
  const endingActive = session.direction === "inbound" && plan.source === "incoming_flow" && endingReached && customerActive && !callbackConfirmed && !session.answered_at;
  if (session.direction === "inbound" && plan.source === "incoming_flow") occurrences.push({
    id: `${session.id}:ending`, executionIndex: steps.length, sourceStepId: null, kind: "ending",
    label: endingKind === "callback_prompt" ? "Ponúknuť spätné volanie" : endingKind === "hangup_message" ? "Hlásenie a ukončenie" : "Ukončiť hovor",
    state: endingActive ? "active" : endingReached ? "completed" : customerActive && !session.answered_at && !callbackConfirmed ? "pending" : "not_reached",
    startedAt: stamp(endingEvent?.at), endedAt: callbackConfirmed ? stamp(callback.requestedAt) : customerEnded,
    configuredSeconds: null, timingBasis: endingEvent ? "observed_transition" : "unknown", reason: endingReached ? callbackConfirmed ? "callback_requested" : safeReason(input.call?.end_reason) : null, endpoints: [],
  });
  const eventLabel = (state: unknown, phase: JourneyPhase, at: string) => state === "missed" ? "Ukončovanie hovoru" : state === "waiting" ? "Čakáreň" : state === "callback_offered"
    ? callbackConfirmed && stamp(callback.requestedAt) && Date.parse(at) >= Date.parse(callback.requestedAt!) ? "Potvrdenie spätného volania" : "Ponuka spätného volania"
    : JOURNEY_PHASE_LABELS[phase];
  const journeyEvents: JourneyEvent[] = entries.filter(entry => entry.kind === "phase").map(entry => {
    const phase = phaseForState(entry.phase) ?? (typeof entry.phase === "string" && Object.hasOwn(JOURNEY_PHASE_LABELS, entry.phase) ? entry.phase as JourneyPhase : "unknown");
    return { id: String(entry.id), at: String(entry.at), kind: safeReason(entry.phase) ?? "unknown", label: eventLabel(entry.phase, phase, String(entry.at)), ...(safeReason(entry.reason) ? { reason: String(entry.reason) } : {}) };
  });
  // Old calls still get a truthful coarse history; never parse free-text notes.
  for (const event of input.events) {
    const payload = record(event.normalized_payload);
    if (payload.session_id !== session.id || payload.state_before === payload.state_after || event.handled_status !== "processed") continue;
    const eventPhase = phaseForState(payload.state_after), at = stamp(event.provider_timestamp) ?? stamp(event.received_at);
    if (!eventPhase || !at || journeyEvents.some(item => item.id.startsWith(`${event.id}:phase:`) || item.at === at && item.kind === payload.state_after)) continue;
    journeyEvents.push({ id: event.id, at, kind: String(payload.state_after), label: eventLabel(payload.state_after, eventPhase, at) });
  }
  if (callbackConfirmed && stamp(callback.requestedAt) && !journeyEvents.some(event => event.kind === "callback_requested")) journeyEvents.push({ id: `${session.id}:callback`, at: callback.requestedAt!, kind: "callback_requested", label: "Klient požiadal o spätné volanie" });
  if (customerEnded && !journeyEvents.some(event => event.kind === "ended" && event.at === customerEnded)) journeyEvents.push({ id: `${session.id}:customer-ended`, at: customerEnded, kind: "customer_ended", label: "Hovor s volajúcim skončil" });
  journeyEvents.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const truncated = Boolean(input.truncated || evidence.truncated || array(plan.steps).length > 100 || array(evidence.entries).length > 512 || journeyEvents.length > 512);
  const hasEvidence = occurrences.some(item => item.state !== "not_reached" && item.state !== "pending") || journeyEvents.length > 0 || validAttempts.length > 0;
  return { version: 1, sessionId: session.id, callId: input.call?.id ?? null, lineId: session.line_id, direction: session.direction,
    callerNumber: phone(session.caller_number), calledNumber: phone(session.called_number), phase, sessionState: session.state, sessionVersion: session.version, asOf: input.now.toISOString(),
    customerActive, sessionActive, startedAt: session.started_at, answeredAt: stamp(session.answered_at), endedAt: customerEnded,
    flow: { source: plan.source === "incoming_flow" ? "incoming_flow" : steps.length ? "legacy" : "unknown", signature: safeText(plan.flowSignature) },
    currentOccurrenceId: activeIndex !== null && steps[activeIndex] ? occurrenceId(activeIndex) : endingActive ? `${session.id}:ending` : null,
    coverage: !hasEvidence ? "unavailable" : truncated || missingTiming || evidence.version !== 1 ? "partial" : "complete", truncated,
    occurrences, events: journeyEvents.slice(0, 512), callback: callbackConfirmed || input.callback ? { kind: callback.kind, requestedAt: stamp(callback.requestedAt), digit: typeof callback.digit === "string" && /^[0-9*#]$/.test(callback.digit) ? callback.digit : null } : null };
}

const MAX_ACTIVE = 20, ATTEMPT_LIMIT = 1000, LEG_LIMIT = 400, EVENT_LIMIT = 400;
type ReadDeps = { admin: Admin; organizationId: string; now?: () => Date };
function check(error: { message: string } | null, operation: string): void { if (error) throw new Error(`Call journey ${operation} failed`); }

async function readJourneys(deps: ReadDeps, sessions: SessionRow[], calls: Array<Pick<CallRow, "id" | "session_id" | "end_reason" | "ended_at">>): Promise<CallJourney[]> {
  if (!sessions.length) return [];
  const ids = sessions.map(session => session.id), callIds = calls.map(call => call.id);
  const [attemptsResult, legsResult, customersResult, eventsResult, callbacksResult] = await Promise.all([
    deps.admin.from("motorist_ring_attempts").select("*").eq("organization_id", deps.organizationId).in("session_id", ids).order("created_at", { ascending: true }).limit(ATTEMPT_LIMIT),
    deps.admin.from("motorist_call_legs").select("*").eq("organization_id", deps.organizationId).in("session_id", ids).order("created_at", { ascending: true }).limit(LEG_LIMIT),
    // Customer position must not disappear when many historical offer legs hit the cap.
    deps.admin.from("motorist_call_legs").select("*").eq("organization_id", deps.organizationId).in("session_id", ids).eq("role", "customer").order("created_at", { ascending: true }).limit(100),
    callIds.length ? deps.admin.from("motorist_call_events").select("id,call_id,normalized_payload,received_at,provider_timestamp,handled_status").eq("organization_id", deps.organizationId).in("call_id", callIds).order("received_at", { ascending: true }).order("id", { ascending: true }).limit(EVENT_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    deps.admin.from("motorist_callback_requests").select("session_id,source,metadata,created_at").eq("organization_id", deps.organizationId).in("session_id", ids).order("created_at", { ascending: false }).limit(100),
  ]);
  check(attemptsResult.error, "attempts"); check(legsResult.error, "legs"); check(customersResult.error, "customers"); check(eventsResult.error, "events"); check(callbacksResult.error, "callbacks");
  const attempts = attemptsResult.data ?? [], legs = [...new Map([...(legsResult.data ?? []), ...(customersResult.data ?? [])].map(leg => [leg.id, leg])).values()], events = eventsResult.data ?? [], callbacks = callbacksResult.data ?? [];
  const profileIds = [...new Set([...attempts.map(row => row.profile_id), ...legs.map(row => row.profile_id), ...events.flatMap(event => array(record(event.normalized_payload).routing).flatMap(item => array(record(item).members).map(member => record(member).profileId)))].filter((id): id is string => uuid(id)))].slice(0, 128);
  const profilesResult = profileIds.length ? await deps.admin.from("motorist_profiles").select("id,display_name").eq("organization_id", deps.organizationId).in("id", profileIds).limit(128) : { data: [], error: null };
  check(profilesResult.error, "profiles");
  const profiles = new Map((profilesResult.data ?? []).map(row => [row.id, row.display_name]));
  const truncated = attempts.length >= ATTEMPT_LIMIT || (legsResult.data?.length ?? 0) >= LEG_LIMIT || (customersResult.data?.length ?? 0) >= 100 || events.length >= EVENT_LIMIT || callbacks.length >= 100;
  const now = (deps.now ?? (() => new Date()))();
  return sessions.map(session => projectCallJourney({ session, call: calls.find(call => call.session_id === session.id) ?? null,
    attempts: attempts.filter(attempt => attempt.session_id === session.id), legs: legs.filter(leg => leg.session_id === session.id), events: events.filter(event => record(event.normalized_payload).session_id === session.id), profiles,
    callback: callbacks.find(callback => callback.session_id === session.id), now, truncated }));
}

/** Read-only endpoint: does not invoke active-call sweep or provider recovery. */
export async function loadActiveCallJourneys(deps: ReadDeps, lineId?: string): Promise<{ calls: CallJourney[]; truncated: boolean; checkedAt: string }> {
  if (lineId && !isUuid(lineId)) throw new MutationError("Neplatná linka.", 400);
  if (lineId) {
    const line = await deps.admin.from("motorist_telephony_lines").select("id").eq("organization_id", deps.organizationId).eq("id", lineId).maybeSingle();
    check(line.error, "line"); if (!line.data) throw new MutationError("Linka sa nenašla.", 404);
  }
  let query = deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).in("state", [...ACTIVE_SESSION_STATES]).is("ended_at", null).order("started_at", { ascending: true }).order("id", { ascending: true }).limit(MAX_ACTIVE + 1);
  let closingQuery = deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("state", "missed").is("ended_at", null)
    .or("metadata->>closing_message.eq.true,metadata->ring->>fallback.eq.hangup_message").order("started_at", { ascending: true }).order("id", { ascending: true }).limit(MAX_ACTIVE + 1);
  if (lineId) { query = query.eq("line_id", lineId).eq("direction", "inbound"); closingQuery = closingQuery.eq("line_id", lineId).eq("direction", "inbound"); }
  const [result, closing] = await Promise.all([query, closingQuery]); check(result.error, "sessions"); check(closing.error, "closing sessions");
  const selected = [...(result.data ?? []), ...(closing.data ?? [])].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || a.id.localeCompare(b.id));
  const sessions = selected.slice(0, MAX_ACTIVE);
  const calls = sessions.length ? await deps.admin.from("motorist_calls").select("id,session_id,end_reason,ended_at").eq("organization_id", deps.organizationId).in("session_id", sessions.map(session => session.id)) : { data: [], error: null };
  check(calls.error, "calls");
  return { calls: await readJourneys(deps, sessions, calls.data ?? []), truncated: selected.length > MAX_ACTIVE, checkedAt: (deps.now ?? (() => new Date()))().toISOString() };
}

export async function loadCallJourney(deps: ReadDeps, id: string, identity: "call" | "session" = "call"): Promise<CallJourney> {
  if (!isUuid(id)) throw new MutationError("Neplatný hovor.", 400);
  const call = await deps.admin.from("motorist_calls").select("id,session_id,end_reason,ended_at").eq("organization_id", deps.organizationId).eq(identity === "call" ? "id" : "session_id", id).maybeSingle();
  check(call.error, "call");
  const sessionId = identity === "session" ? id : call.data?.session_id;
  if (!sessionId) throw new MutationError("Priebeh hovoru nie je dostupný.", 404);
  const session = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", sessionId).maybeSingle();
  check(session.error, "session"); if (!session.data) throw new MutationError("Priebeh hovoru nie je dostupný.", 404);
  return (await readJourneys(deps, [session.data], call.data ? [call.data] : []))[0];
}
