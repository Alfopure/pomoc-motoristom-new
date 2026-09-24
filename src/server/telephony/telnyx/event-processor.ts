import type { SupabaseClient } from "@supabase/supabase-js";
import { requestTimingContext } from "@/server/request-metrics";

import type { Database } from "@/lib/supabase/database.types";
import { announcementConfigFromMetadata } from "@/lib/telephony/announcements";

import { recordTelephonyIncident, recoverTelephonyIncidentThrottled, TELEPHONY_INCIDENT_JOBS } from "../incidents";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { sweepOverdueRingSteps } from "../routing/ring-plan";
import { effectsDeps, ownedSessionWork, runSessionEvent, SessionEventDeferredError, WEBHOOK_LEASE_WAIT_MS, type SessionRunnerDeps } from "../session-runner";
import { describeServiceError, SessionLeaseBusyError } from "../service-errors";
import { recordCallEvent, type CommandOutcome } from "../state/effects";
import { classifyEventType, parseTelnyxEnvelope, type EventClass } from "../state/events";
import { toJson, type LineRow, type SessionRow, type TelephonyEvent } from "../state/types";
import { readMeta } from "../state/types";
import { loadParticipantManifest, observeParticipants } from "../state/participants";
import { enqueueSavedRecording } from "../recording-jobs";
import { recordingIntent } from "../state/recording";
import { claimWebhookEvent, markWebhookEventFailed, markWebhookEventProcessed, type WebhookClaim } from "./webhook-ledger";

/**
 * Telnyx webhook processor (design §2.3).
 *
 * Signature verification happens in the route; this module does everything
 * after it: connection-id check, control/bookkeeping classification, claim
 * ledger, session resolution (creating the session for an inbound
 * `call.initiated`), the per-session pipeline and the ledger bookkeeping.
 *
 * Response policy: compensated command failures keep their existing 200 path.
 * Events blocked before applying a transition request provider redelivery;
 * acknowledging those would strand an answer/hangup until a later cron replay.
 * A deferral schedules its own drain after the response (E2.1); audio
 * completions for an ended customer leg are acknowledged without the lease
 * (E2.4).
 */

type AdminClient = SupabaseClient<Database>;

export type ProcessorDeps = SessionRunnerDeps & {
  /** Run the overdue-step sweep after each control event (design §2.3 item 9a). */
  sweepAfterEvent?: boolean;
  /** Internal durable replay; never changes the envelope authorization rules. */
  ledgerReplay?: "cron" | "correlation";
  replayCorrelated?: boolean;
  /** Sessions the inline sweep may re-drive (default `INLINE_SWEEP_LIMIT`). */
  sweepLimit?: number;
  /** Wall-clock budget shared by the event and its inline sweep. */
  sweepBudgetMs?: number;
  /** The HTTP host retains this work after replying; cron/tests await it inline. */
  deferMaintenance?: (work: () => Promise<void>) => void;
};

/** Keep SIP processing fast; the larger route duration also covers after-response push. */
export const INLINE_SWEEP_LIMIT = 2;
export const INLINE_SWEEP_BUDGET_MS = 8_000;
/** Room for one E4.2 customer-hangup drain inside the webhook's retained maintenance (route `maxDuration` 60 s:
 *  event + correlated replay ≤ 8 s + this drain ≤ 10 s + inline sweep 4 s + push 15 s leave > 20 s reserve). */
export const INLINE_DRAIN_BUDGET_MS = 20_000;
/** Wall deadline of one session-inbox drain (`replayReadySessionEvents`); `CUSTOMER_DRAIN_MIN_BUDGET_MS` is built on it. */
export const DEFERRED_DRAIN_DEADLINE_MS = 8_000;

/**
 * Session-inbox drain order for deferred control facts: a terminal fact must win
 * over a leg patch or an audio no-op that is queued in front of it. E1b's cron
 * replay uses the same ranks. Only these types are drained in-process; the
 * customer-terminal (failed-owner) path stays hangup-only.
 */
export const DEFERRED_EVENT_RANK: Readonly<Record<string, number>> = {
  "call.hangup": 0, "call.answered": 1, "call.bridged": 2, "call.initiated": 3,
  "call.hold": 4, "call.unhold": 4,
  "call.gather.ended": 5, "call.playback.ended": 5, "call.speak.ended": 5,
};
const DEFERRED_DRAIN_TYPES = Object.keys(DEFERRED_EVENT_RANK);
/** Wide enough that low-ranked audio rows cannot push a later hangup out of the page. */
const DEFERRED_DRAIN_LIMIT = 40;

/** Audio facts whose reducer branch is a pure ignore once the customer leg is gone. */
const LEASE_FREE_IGNORE_TYPES: ReadonlySet<string> = new Set(["call.gather.ended", "call.playback.ended", "call.speak.ended"]);
/** `wrap_up` only ever advances to `ended` (transitions.ts `TERMINAL_STATES || wrap_up` / stale finalise), so it is monotone like the terminal states. */
const LEASE_FREE_IGNORE_STATES: ReadonlySet<string> = new Set(["ended", "wrap_up", "failed"]);

export type ProcessorOutcome = "processed" | "ignored" | "duplicate" | "busy" | "failed" | "malformed" | "unverified_connection" | "unknown_session" | "awaiting_correlation" | "unresolved";

export type ProcessorResult = {
  status: 200 | 400 | 500;
  outcome: ProcessorOutcome;
  eventId: string | null;
  type: string | null;
  eventClass: EventClass | null;
  sessionId: string | null;
  claim: WebhookClaim | null;
  commands: CommandOutcome[];
  notes: string[];
  error: string | null;
  ms: number;
};

function nowOf(deps: ProcessorDeps): () => Date {
  return deps.now ?? (() => new Date());
}

export function allowedConnectionIds(deps: Pick<ProcessorDeps, "config">): Set<string> {
  const ids = new Set<string>();
  if (deps.config.configured) {
    if (deps.config.callControlAppId) ids.add(deps.config.callControlAppId);
    if (deps.config.credentialConnectionId) ids.add(deps.config.credentialConnectionId);
  }
  return ids;
}

async function findSession(admin: AdminClient, organizationId: string, event: TelephonyEvent): Promise<SessionRow | null> {
  if (event.clientState?.sid) {
    const byId = await admin.from("motorist_call_sessions").select("*").eq("organization_id", organizationId).eq("id", event.clientState.sid).maybeSingle();
    if (byId.error) throw new Error(`session lookup failed: ${byId.error.message}`);
    if (byId.data) return byId.data;
  }
  if (event.callControlId) {
    const leg = await admin.from("motorist_call_legs").select("session_id").eq("organization_id", organizationId).eq("telnyx_call_control_id", event.callControlId).maybeSingle();
    if (leg.error) throw new Error(`leg lookup failed: ${leg.error.message}`);
    if (leg.data) {
      const byLeg = await admin.from("motorist_call_sessions").select("*").eq("organization_id", organizationId).eq("id", leg.data.session_id).maybeSingle();
      if (byLeg.error) throw new Error(`session lookup failed: ${byLeg.error.message}`);
      if (byLeg.data) return byLeg.data;
    }
  }
  if (event.callSessionId) {
    const bySession = await admin.from("motorist_call_sessions").select("*").eq("organization_id", organizationId).eq("telnyx_session_id", event.callSessionId).maybeSingle();
    if (bySession.error) throw new Error(`session lookup failed: ${bySession.error.message}`);
    // A provider session can contain several legs. An unregistered control ID
    // without our exact client-state correlation must wait for its own leg.
    if (bySession.data && !event.callControlId) return bySession.data;
  }
  if (event.conferenceId) {
    const conference = await admin.from("motorist_call_sessions").select("*").eq("organization_id", organizationId).eq("conference_id", event.conferenceId).maybeSingle();
    if (conference.error) throw new Error("conference session lookup failed");
    if (conference.data) return conference.data;
  }
  return null;
}

/**
 * A gather/playback/speak completion for a customer leg that has already
 * ended is `ignoredResult("customer leg ended")` in the reducer
 * (`onGatherEnded`/`onPlaybackEnded`); in `ended`/`wrap_up`/`failed` the same
 * handlers fall through to `gather in <state>` / `playback ended in <state>`.
 * Both facts are monotone (`ended_at` never clears, those states never
 * revive), so acknowledging without the lease cannot become wrong later, and
 * it keeps the lease free for the answer/hangup queued behind it (M03/M16: 8
 * such rows cost 48 deliveries and 8 cron slots on 21 Sep). Returns the
 * reducer's reason, or null when the reducer must decide. The `role` check
 * uses the leg row, never client_state; `ended_at` is used rather than
 * `leg.state`, which `onSdkHold` rewrites even on an ended leg.
 */
async function leaseFreeIgnoreReason(deps: ProcessorDeps, session: SessionRow, event: TelephonyEvent): Promise<string | null> {
  if (!LEASE_FREE_IGNORE_TYPES.has(event.type) || !event.callControlId) return null;
  const leg = await deps.admin.from("motorist_call_legs").select("role, ended_at")
    .eq("organization_id", deps.organizationId).eq("session_id", session.id)
    .eq("telnyx_call_control_id", event.callControlId).maybeSingle();
  if (leg.error || !leg.data || leg.data.role !== "customer") return null;
  if (leg.data.ended_at) return "customer leg ended";
  if (LEASE_FREE_IGNORE_STATES.has(session.state)) {
    return event.type === "call.gather.ended" ? `gather in ${session.state}` : `playback ended in ${session.state}`;
  }
  return null;
}

async function findLine(deps: ProcessorDeps, environment: string, to: string | null): Promise<LineRow | null> {
  const { admin, organizationId } = deps;
  const normalized = to ? normalizeE164(to) : null;
  if (!normalized) return null;
  const pick = (rows: LineRow[]): LineRow | null => rows.find((row) => row.environment === environment) ?? rows[0] ?? null;

  const exact = await admin.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId).eq("phone_number", normalized).eq("active", true);
  if (exact.error) throw new Error(`line lookup failed: ${exact.error.message}`);
  const hit = pick(exact.data ?? []);
  if (hit) return hit;

  // A row stored in a non-canonical shape (`02/3240 8700`, `+4210232408700`)
  // would otherwise leave the call without a line, a ring plan or an IVR. A
  // trigger normalises new writes; this keeps existing data working.
  const all = await admin.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId).eq("active", true);
  if (all.error) throw new Error(`line lookup failed: ${all.error.message}`);
  const loose = (all.data ?? []).filter((row) => normalizeE164(row.phone_number) === normalized);
  const match = pick(loose);
  if (match) {
    deps.logger?.({ level: "warn", scope: "processor", message: "line number is not canonical E.164", lineId: match.id, stored: match.phone_number, normalized });
  }
  return match;
}

/** Creates the session + customer leg for an inbound `call.initiated` (idempotent on `telnyx_session_id`). */
export async function createInboundSession(deps: ProcessorDeps, event: TelephonyEvent): Promise<SessionRow> {
  const { admin, organizationId } = deps;
  const now = nowOf(deps)();
  const sourceLine = await findLine(deps, deps.environment, event.to);
  const sourceMetadata = sourceLine?.metadata;
  const hasReturnRoute = sourceMetadata && typeof sourceMetadata === "object" && !Array.isArray(sourceMetadata) && Boolean(sourceMetadata.return_line_id);
  const line = hasReturnRoute
    ? await (await import("../return-line")).resolveInboundReturnLine(admin, organizationId, sourceLine)
    : sourceLine;
  const callerNumber = event.from ? (normalizeE164(event.from) ?? event.from) : null;
  const calledNumber = event.to ? (normalizeE164(event.to) ?? event.to) : null;

  const inserted = await admin
    .from("motorist_call_sessions")
    .insert({
      organization_id: organizationId,
      telnyx_session_id: event.callSessionId,
      direction: "inbound",
      state: "received",
      version: 0,
      current_step: 0,
      line_id: line?.id ?? null,
      ring_plan_id: line?.ring_plan_id ?? null,
      // A number can belong to several people or older cases. Inbound calls
      // start unassigned; a dispatcher links the call explicitly.
      case_id: null,
      caller_number: callerNumber,
      called_number: calledNumber,
      started_at: event.occurredAt ?? now.toISOString(),
      metadata: toJson({ line_label: sourceLine?.label ?? null, partner_name: sourceLine?.partner_name ?? null, environment: deps.environment, announcements: announcementConfigFromMetadata(line?.metadata), ...(sourceLine && line && sourceLine.id !== line.id ? { return_routing: { source_line_id: sourceLine.id, target_line_id: line.id, original_called_number: calledNumber } } : {}) }),
    })
    .select("*")
    .single();

  let session: SessionRow;
  if (inserted.error) {
    if (inserted.error.code !== "23505" || !event.callSessionId) throw new Error(`session insert failed: ${inserted.error.message}`);
    // Org-scoped like every other read here: a row that belongs to another
    // organisation must never be adopted, however unique the Telnyx id is.
    const existing = await admin
      .from("motorist_call_sessions")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("telnyx_session_id", event.callSessionId)
      .maybeSingle();
    if (existing.error || !existing.data) throw new Error(`session insert conflict but no row: ${existing.error?.message ?? "missing"}`);
    session = existing.data;
  } else {
    session = inserted.data;
  }

  return ownedSessionWork({ ...deps, leaseWaitMs: WEBHOOK_LEASE_WAIT_MS }, session.id, async () => {
    if (event.callControlId) {
      const leg = await admin
        .from("motorist_call_legs")
        .upsert(
          {
            organization_id: organizationId,
            session_id: session.id,
            telnyx_call_control_id: event.callControlId,
            telnyx_call_leg_id: event.callLegId,
            role: "customer",
            to_number: calledNumber,
            from_number: callerNumber,
            state: "initiated",
            initiated_at: event.occurredAt ?? now.toISOString(),
            client_state: toJson({ sid: session.id, role: "customer" }),
          },
          { onConflict: "telnyx_call_control_id" },
        )
        .select("id")
        .single();
      if (leg.error) throw new Error(`customer leg upsert failed: ${leg.error.message}`);
      if (!session.customer_leg_id) {
        const updated = await admin.from("motorist_call_sessions").update({ customer_leg_id: leg.data.id }).eq("id", session.id).is("customer_leg_id", null).select("*").maybeSingle();
        if (updated.data) session = updated.data;
        else session = { ...session, customer_leg_id: leg.data.id };
      }
    }
    return session;
  }, { known: session, eventType: event.type });
}

export async function processTelnyxEvent(deps: ProcessorDeps, envelope: unknown): Promise<ProcessorResult> {
  const now = nowOf(deps);
  const started = now().getTime();
  const done = (partial: Omit<ProcessorResult, "ms">): ProcessorResult => {
    const result = { ...partial, ms: now().getTime() - started };
    if (event) {
      try { deps.logger?.({ scope: "webhook-delivery", eventId: event.id, type: event.type,
        outcome: result.outcome, sessionId: result.sessionId, status: result.status, ms: result.ms,
        timing: event.timing, meta: { attempt: event.deliveryAttempt, delivered_to: event.deliveredTo } }); }
      catch { /* Telemetry cannot change acknowledgement policy. */ }
    }
    return result;
  };
  const base = { eventId: null, type: null, eventClass: null, sessionId: null, claim: null, commands: [], notes: [], error: null } satisfies Omit<ProcessorResult, "status" | "outcome" | "ms">;

  const event = parseTelnyxEnvelope(envelope);
  if (!event) return done({ ...base, status: 400, outcome: "malformed" });
  event.timing = { ingress_at: new Date(started).toISOString(), ...requestTimingContext(), source: deps.ledgerReplay ? "ledger_replay" : "delivery" };
  const eventClass = classifyEventType(event.type);
  const identity = { ...base, eventId: event.id, type: event.type, eventClass };

  const allowed = allowedConnectionIds(deps);
  if (event.connectionId && allowed.size > 0 && !allowed.has(event.connectionId)) {
    deps.logger?.({ scope: "webhook", eventId: event.id, type: event.type, outcome: "unverified_connection", connectionId: event.connectionId });
    return done({ ...identity, status: 200, outcome: "unverified_connection" });
  }

  const claim = await claimWebhookEvent(deps.admin, {
    eventId: event.id,
    eventType: event.type,
    payload: toJson(event.type.includes("recording.") ? { recording_id: event.payload.recording_id ?? null, recording_started_at: event.payload.recording_started_at ?? null,
      recording_ended_at: event.payload.recording_ended_at ?? null, call_control_id: event.callControlId, client_state: event.rawClientState } : event.payload),
    organizationId: deps.organizationId,
    callSessionId: event.callSessionId,
    callLegId: event.callLegId,
    callControlId: event.callControlId,
    connectionId: event.connectionId,
    occurredAt: event.occurredAt,
    replay: deps.ledgerReplay,
  });
  event.timing.claimed_at = claim.claimedAt ?? null;
  if (claim.outcome === "terminal") {
    await recordTelephonyIncident(deps.admin, { job: TELEPHONY_INCIDENT_JOBS.webhook, error: new Error(claim.terminalReason ?? "Webhook dead letter"), context: { eventId: event.id, type: event.type, terminalReason: claim.terminalReason } });
    return done({ ...identity, claim, status: 200, outcome: "unresolved", error: claim.terminalReason });
  }
  if (claim.outcome !== "claimed") {
    return done({ ...identity, claim, status: claim.outcome === "busy" ? 500 : 200, outcome: claim.outcome });
  }

  // AI demo legs are not dispatch sessions: they have no operator, no ring plan
  // and no reducer state, and `findSession` below would answer
  // `awaiting_correlation` for every one of them. The branch sits after the
  // ledger claim so duplicates, dead-lettering and replay are already handled,
  // and before `findSession` so the human path is byte-identical. The handler
  // is imported dynamically — with the demo switched off it is never loaded,
  // and the webhook's static module budget is unchanged. That budget is also
  // why the intent prefix is a literal here rather than an import from
  // `ai-demo/flag.ts`; `identity.test.ts` asserts the two agree.
  if (event.clientState?.intent?.startsWith("ai_demo:") === true) {
    try {
      const { handleAiDemoTelnyxEvent } = await import("../ai-demo/telnyx-events");
      const outcome = await handleAiDemoTelnyxEvent(deps, event);
      // A state that carries the prefix but is not a well-formed demo state is
      // not ours to acknowledge. Falling through leaves it to the ordinary
      // correlation path, which is where an unrecognised leg belongs.
      if (!outcome.handled && outcome.reason === "not_ai_demo") {
        deps.logger?.({ level: "warn", scope: "ai-demo", eventId: event.id, type: event.type, message: "malformed demo client_state" });
      } else {
        await markWebhookEventProcessed(deps.admin, event.id, { now, claimedAt: claim.claimedAt, logger: deps.logger });
        return done({
          ...identity,
          claim,
          status: 200,
          outcome: outcome.handled ? "processed" : "ignored",
          notes: [outcome.handled ? `ai_demo:${outcome.action}` : `ai_demo:${outcome.reason}`],
        });
      }
    } catch (error) {
      // Without the table there can be no demo, so such a leg is not ours.
      // Retrying it forever would be the wrong answer to a migration that was
      // simply never applied.
      if ((error as { name?: string }).name === "AiDemoMigrationMissingError") {
        deps.logger?.({ level: "warn", scope: "ai-demo", eventId: event.id, type: event.type, message: "demo table missing" });
      } else {
        // Every demo transition is conditional, so a redelivery cannot repeat
        // an effect; asking for one is strictly better than losing the event.
        const message = error instanceof Error ? error.message : String(error);
        await markWebhookEventFailed(deps.admin, event.id, "ai_demo_handler_failed", { claimedAt: claim.claimedAt, logger: deps.logger, releaseForRetry: true });
        deps.logger?.({ level: "error", scope: "ai-demo", eventId: event.id, type: event.type, message: "handler failed", error: message });
        return done({ ...identity, claim, status: 500, outcome: "failed", error: "ai_demo_handler_failed" });
      }
    }
  }

  const effects = effectsDeps(deps);
  let session: SessionRow | null = null;
  let processingStarted = false;
  try {
    session = await findSession(deps.admin, deps.organizationId, event);
    // Only the call-control application sees real customers. A leg arriving at
    // the credential connection is our own dial reaching an operator's browser:
    // it is "incoming" from that connection's point of view, and turning it
    // into a customer session would fork the call in two and answer a leg the
    // API refuses to answer. The connection's webhook URL is unset for this
    // reason; this guard keeps the mistake harmless if it is ever set again.
    const credentialConnectionId = deps.config.configured ? deps.config.credentialConnectionId : null;
    const fromCredentialConnection = Boolean(credentialConnectionId && event.connectionId === credentialConnectionId);
    if (!session && event.type === "call.initiated" && event.direction === "incoming" && eventClass === "control" && !fromCredentialConnection && Boolean(event.connectionId && allowed.has(event.connectionId))) {
      session = await createInboundSession(deps, event);
    }

    if (!session) {
      if (event.connectionId && allowed.has(event.connectionId)) {
        await markWebhookEventFailed(deps.admin, event.id, "Awaiting exact session/leg correlation", { claimedAt: claim.claimedAt, logger: deps.logger, awaitingCorrelation: true });
        const expired = claim.receivedAt !== null && now().getTime() - Date.parse(claim.receivedAt) >= 60_000;
        if (expired) await recordTelephonyIncident(deps.admin, { job: TELEPHONY_INCIDENT_JOBS.webhook, error: new Error("awaiting_correlation_expired"), context: { eventId: event.id, type: event.type } });
        return done({ ...identity, claim, status: expired ? 200 : 500, outcome: expired ? "unresolved" : "awaiting_correlation", notes: ["awaiting exact correlation"] });
      }
      await markWebhookEventProcessed(deps.admin, event.id, { now, claimedAt: claim.claimedAt, logger: deps.logger });
      return done({ ...identity, claim, status: 200, outcome: "unknown_session", notes: ["missing allowed connection correlation"] });
    }

    const ownedSession = session;

    // Bookkeeping that writes nothing fenced does not take the session lease.
    //
    // Every webhook used to, and that is where the redeliveries come from: a
    // callback arriving while our own invocation still holds the lease is
    // deferred, and Telnyx retries it up to six times. On 18 Sep, 66
    // `conference.floor.changed` events cost 163 deliveries — a fifth of all
    // webhook traffic — for an event whose entire handling is one audit row in
    // `motorist_call_events`, a table no write guard covers.
    //
    // The recording callbacks are the exception: they write `motorist_calls`,
    // which is fenced, and may run a session event of their own.
    const leaseFree = eventClass === "bookkeeping" &&
      event.type !== "call.recording.saved" && event.type !== "conference.recording.saved";
    if (leaseFree) {
      processingStarted = true;
      await recordCallEvent(effectsDeps(deps), { session: ownedSession, event, handledStatus: "processed",
        stateBefore: ownedSession.state, stateAfter: ownedSession.state, notes: ["bookkeeping"], commands: [] });
      await markWebhookEventProcessed(deps.admin, event.id, { now, claimedAt: claim.claimedAt, logger: deps.logger });
      const bookkeeping = done({ ...identity, claim, sessionId: ownedSession.id, status: 200, outcome: "processed", notes: ["bookkeeping", "lease-free"] });
      if (deps.deferMaintenance) {
        try { deps.deferMaintenance(() => maybeSweep(deps, started)); }
        catch { await maybeSweep(deps, started); }
      } else await maybeSweep(deps, started);
      return bookkeeping;
    }

    // Lease-free acknowledgement of pure reducer ignores (E2.4). Never for
    // call.initiated/call.answered (orphan hangup, leg insert) nor for
    // hold/unhold/conference.* (they write leg state and `sdk_hold` even on
    // wrap_up/ended sessions — D1 B7). The cron replays through this same
    // function, so it gets the same short-circuit.
    const ignoreReason = eventClass === "control" ? await leaseFreeIgnoreReason(deps, ownedSession, event) : null;
    if (ignoreReason) {
      processingStarted = true;
      await recordCallEvent(effects, { session: ownedSession, event, handledStatus: "ignored",
        stateBefore: ownedSession.state, stateAfter: ownedSession.state, notes: [ignoreReason, "lease-free"], commands: [] });
      await markWebhookEventProcessed(deps.admin, event.id, { now, claimedAt: claim.claimedAt, logger: deps.logger });
      logResult(deps, event, claim, ownedSession.id, "ignored", [], started, now);
      const ignored = done({ ...identity, claim, sessionId: ownedSession.id, status: 200, outcome: "ignored", notes: [ignoreReason, "lease-free"] });
      // Same after-response work as a reducer ignore: this host may drain the
      // session's deferred rows and sweep, exactly as the leased path did.
      const ignoredMaintenance = async () => { await replayCorrelatedEvents(deps, event, ownedSession); await maybeSweep(deps, started); };
      if (deps.deferMaintenance) {
        try { deps.deferMaintenance(ignoredMaintenance); }
        catch { await ignoredMaintenance(); }
      } else await ignoredMaintenance();
      return ignored;
    }

    // The durable webhook ledger owns retry. Do not have every simultaneous
    // provider callback poll the same database lease while a control is waiting.
    let failedOwnerReplayEligible = false;
    const result = await ownedSessionWork({ ...deps, leaseWaitMs: WEBHOOK_LEASE_WAIT_MS }, ownedSession.id, async () => {
      processingStarted = true;
      if (eventClass === "bookkeeping") {
        if (event.type === "call.recording.saved" || event.type === "conference.recording.saved") {
          const payload = event.payload;
          const urls = payload.recording_urls && typeof payload.recording_urls === "object" ? payload.recording_urls as Record<string, unknown> : {};
          const sourceUrl = typeof urls.wav === "string" ? urls.wav : typeof urls.mp3 === "string" ? urls.mp3 : null;
          const providerRecordingId = typeof payload.recording_id === "string" ? payload.recording_id : null;
          const startedAt = typeof payload.recording_started_at === "string" ? payload.recording_started_at : null;
          const endedAt = typeof payload.recording_ended_at === "string" ? payload.recording_ended_at : null;
          // Only requested, announced captures from our registry enter processing. A provider
          // recording enabled in its portal must not silently become an authorised app recording.
          const recorder = readMeta(ownedSession).recording?.recorders.find((r) => r.callControlId === event.callControlId && (r.providerRecordingId && typeof event.payload.recording_id === "string" ? r.providerRecordingId === event.payload.recording_id : event.clientState?.intent === recordingIntent(r.id)));
          if (recorder && providerRecordingId && sourceUrl && startedAt && endedAt && Number.isFinite(Date.parse(startedAt)) && Date.parse(endedAt) >= Date.parse(startedAt)) {
            const call = await deps.admin.from("motorist_calls").select("id").eq("organization_id", deps.organizationId).eq("session_id", ownedSession.id).maybeSingle();
            if (call.error || !call.data) throw new Error("recording call association unavailable");
            await enqueueSavedRecording(deps.admin, { organizationId: deps.organizationId, callId: call.data.id, sessionId: ownedSession.id, providerRecordingId, recorderId: recorder.id,
              providerSessionId: event.callSessionId, startedAt, endedAt, durationSeconds: Math.ceil((Date.parse(endedAt) - Date.parse(startedAt)) / 1000), sourceUrl,
              participantManifest: await loadParticipantManifest(deps.admin, ownedSession, { startedAt, endedAt, recorderId: recorder.id }) });
          } else if (recorder) throw new Error("recording saved payload incomplete");
        }
        if (event.type === "call.recording.saved" || event.type === "call.recording.error") await runSessionEvent(deps, ownedSession.id, event);
        await recordCallEvent(effects, { session: ownedSession, event, handledStatus: "processed", stateBefore: ownedSession.state, stateAfter: ownedSession.state, notes: ["bookkeeping"], commands: [] });
        return done({ ...identity, claim, sessionId: ownedSession.id, status: 200, outcome: "processed", notes: ["bookkeeping"] });
      }

      const run = await runSessionEvent(deps, ownedSession.id, event);
      if (["call.bridged", "call.hangup", "conference.participant.joined", "conference.participant.left"].includes(event.type)) {
        try { await observeParticipants(deps.admin, run.session, event.id, event.occurredAt ?? now().toISOString(), event.type === "call.bridged"); }
        catch { deps.logger?.({ level: "warn", scope: "recording", sessionId: ownedSession.id, code: "participant_observation_failed" }); }
      }
      if (run.outcome === "ignored") {
        logResult(deps, event, claim, ownedSession.id, "ignored", [], started, now);
        return done({ ...identity, claim, sessionId: ownedSession.id, status: 200, outcome: "ignored", notes: [run.reason] });
      }

      if (run.apply.failed) {
        failedOwnerReplayEligible = await markWebhookEventFailed(deps.admin, event.id, run.apply.failure?.error ?? "command failed", { claimedAt: claim.claimedAt, logger: deps.logger });
        logResult(deps, event, claim, ownedSession.id, "failed", run.commands, started, now);
        return done({ ...identity, claim, sessionId: ownedSession.id, status: 200, outcome: "failed", commands: run.commands, notes: run.apply.notes, error: run.apply.failure?.error ?? null });
      }

      logResult(deps, event, claim, ownedSession.id, "processed", run.commands, started, now);
      return done({ ...identity, claim, sessionId: ownedSession.id, status: 200, outcome: "processed", commands: run.commands, notes: run.apply.notes });
    }, { known: ownedSession, eventType: event.type });
    // The fenced transition and audit are complete. Finishing the unfenced
    // inbox claim must not keep the next answer behind one more DB round trip.
    // Failed-owner bookkeeping stays in the scope above for terminal recovery.
    if (result.outcome === "processed" || result.outcome === "ignored") {
      await markWebhookEventProcessed(deps.admin, event.id, { now, claimedAt: claim.claimedAt, logger: deps.logger });
    }
    // The owned scope has exited before optional maintenance. A failed apply
    // may still have durable effects pending; its ledger failure stays truthful.
    // Release can warn without failing the operation; replay must acquire a
    // fresh lease and defer normally if the previous lease remains held.
    // Do not hold the next answer/hangup behind incident reporting or another
    // call's sweep. The HTTP host must retain this promise (Next after), never
    // launch untracked work; direct cron/recovery callers still await it.
    const maintenance = async () => {
      if (result.outcome === "processed" || result.outcome === "ignored") await replayCorrelatedEvents(deps, event, ownedSession);
      else if (failedOwnerReplayEligible && eventClass === "control" && deps.replayCorrelated !== false) {
        await replayReadySessionEvents(deps, ownedSession, event, true);
      }
      if (eventClass === "control" && result.outcome === "processed") {
        await recoverTelephonyIncidentThrottled(deps.admin, TELEPHONY_INCIDENT_JOBS.webhook, now());
      }
      // Give released reservations a bounded sweep after this session's inbox
      // drain. A slow host used to consume the whole sweep budget before the
      // maintenance even began. Retain route time for notifications/cleanup.
      if (now().getTime() - started < 35_000) {
        await maybeSweep(deps, now().getTime(), ["call.hangup", "call.bridged"].includes(event.type));
      }
    };
    if (deps.deferMaintenance) {
      try { deps.deferMaintenance(maintenance); }
      catch {
        deps.logger?.({ level: "warn", scope: "webhook", message: "maintenance scheduling unavailable" });
        await maintenance();
      }
    } else await maintenance();
    return result;
  } catch (error) {
    const message = describeServiceError(error);
    const deferred = error instanceof SessionEventDeferredError || !processingStarted;
    try {
      await markWebhookEventFailed(deps.admin, event.id, error, { claimedAt: claim.claimedAt, logger: deps.logger, releaseForRetry: deferred });
    } catch (ledgerError) {
      deps.logger?.({ level: "error", scope: "webhook", eventId: event.id, message: "ledger update failed", error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError) });
    }
    // Expected contention is observable in the log/ledger. Incident bookkeeping
    // must not delay releasing an unexecuted answer for immediate redelivery.
    if (!deferred) await recordTelephonyIncident(deps.admin, { job: TELEPHONY_INCIDENT_JOBS.webhook, error, context: { eventId: event.id, type: event.type, sessionId: session?.id ?? null } });
    deps.logger?.({ level: deferred ? "warn" : "error", scope: "webhook", eventId: event.id, type: event.type, sessionId: session?.id ?? null, outcome: "failed", error: message, retryable: deferred, ms: now().getTime() - started,
      deferral: error instanceof SessionLeaseBusyError ? "lease_busy" : error instanceof SessionEventDeferredError ? error.code : null,
      ...(error instanceof SessionLeaseBusyError ? { lease_wait_ms: error.details?.waitedMs ?? null, polls: error.details?.polls ?? null } : {}),
      finished_at: new Date().toISOString(),
      timing: event.timing, meta: { attempt: event.deliveryAttempt, delivered_to: event.deliveredTo } });
    // E2.1: a deferred row used to wait for provider redelivery (which collides
    // with the same holder, M01) or for a later webhook of the same call that
    // happened to answer 200 (17 of 58 in the 22 Sep recheck); the rest waited
    // for the cron. The deferring host drains it itself once the response is
    // out and the holder has released, honouring the ledger's SQL backoff. The
    // HTTP answer stays 500: the fact is not applied yet. Without a host
    // (cron/replay callers pass no `deferMaintenance`) nothing is scheduled,
    // and the drain is never run inline: the 500 must go out at once so the
    // redelivery is not delayed, and an inline drain would sit on the lease it
    // competes for.
    if (deferred && session && deps.deferMaintenance) {
      const deferredSessionId = session.id;
      try {
        deps.deferMaintenance(async () => {
          try { await replayDeferredSessionEvents(deps, deferredSessionId); }
          catch (drainError) {
            deps.logger?.({ level: "warn", scope: "webhook", sessionId: deferredSessionId, message: "deferred drain failed", error: drainError instanceof Error ? drainError.message : String(drainError) });
          }
        });
      } catch {
        // No request scope to retain the drain: provider redelivery and the cron remain.
        deps.logger?.({ level: "warn", scope: "webhook", sessionId: deferredSessionId, message: "deferred drain scheduling unavailable" });
      }
    }
    // Preserve the existing compensation policy for ambiguous command failures.
    // A lease deferral has not applied the main transition; neither it nor a
    // failure resolving the session may be acknowledged as completed work.
    const status = eventClass === "control" && session && !deferred ? 200 : 500;
    return done({ ...identity, claim, sessionId: session?.id ?? null, status, outcome: "failed", error: message });
  }
}

async function maybeSweep(deps: ProcessorDeps, startedAt: number, waitingFirst = false): Promise<void> {
  if (deps.sweepAfterEvent === false) return;
  // Keep the original short inline budget even though the route also reserves
  // time for after-response push. Sweep a couple of sessions and leave the exhaustive pass
  // to `/api/telephony/cron` (`RING_SWEEP_LIMIT` / `RING_SWEEP_BUDGET_MS`) and the throttled `calls/active` trigger.
  const spent = nowOf(deps)().getTime() - startedAt;
  const budgetMs = Math.max(0, (deps.sweepBudgetMs ?? INLINE_SWEEP_BUDGET_MS) - spent);
  if (budgetMs <= 0) return;
  try {
    await sweepOverdueRingSteps({
      admin: deps.admin,
      organizationId: deps.organizationId,
      environment: deps.environment,
      waitingFirst,
      now: nowOf(deps),
      limit: deps.sweepLimit ?? INLINE_SWEEP_LIMIT,
      budgetMs,
      // The current session is included on purpose: when every dial of a step failed the fan-out
      // backdates `step_deadline_at` and no Telnyx event will ever arrive to advance it.
      runSessionEvent: (sessionId, event, options) => runSessionEvent(deps, sessionId, event, options),
      // E4.2: one bounded customer-hangup drain per pass, on its own budget (the
      // loop budget alone never reaches `CUSTOMER_DRAIN_MIN_BUDGET_MS`).
      drainCustomerTerminal: (session) => drainCustomerTerminal(deps, session),
      drainBudgetMs: Math.max(0, INLINE_DRAIN_BUDGET_MS - spent),
    });
  } catch (error) {
    deps.logger?.({ level: "warn", scope: "sweep", error: error instanceof Error ? error.message : String(error) });
  }
}

function logResult(deps: ProcessorDeps, event: TelephonyEvent, claim: WebhookClaim, sessionId: string, outcome: string, commands: CommandOutcome[], started: number, now: () => Date): void {
  deps.logger?.({
    scope: "webhook",
    eventId: event.id,
    type: event.type,
    sessionId,
    legId: event.callLegId,
    verified: true,
    timing: event.timing,
    meta: { attempt: event.deliveryAttempt, delivered_to: event.deliveredTo },
    claim: `${claim.outcome}#${claim.attempts}`,
    outcome,
    ms: now().getTime() - started,
    commands: commands.map((command) => `${command.kind}${command.ok ? "" : "!"}`),
  });
}

/** Restore correlation columns omitted from intentionally redacted recording payloads. */
export function storedWebhookEnvelope(row: { event_id: string; event_type: string; occurred_at: string | null; payload: unknown; call_control_id?: string | null; call_session_id?: string | null; call_leg_id?: string | null; connection_id?: string | null }): unknown {
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
  return { data: { id: row.event_id, event_type: row.event_type, occurred_at: row.occurred_at, payload: {
    ...(row.call_control_id ? { call_control_id: row.call_control_id } : {}),
    ...(row.call_session_id ? { call_session_id: row.call_session_id } : {}),
    ...(row.call_leg_id ? { call_leg_id: row.call_leg_id } : {}),
    ...(row.connection_id ? { connection_id: row.connection_id } : {}), ...payload,
  } } };
}

async function replayCorrelatedEvents(deps: ProcessorDeps, current: TelephonyEvent, session: SessionRow): Promise<void> {
  if (deps.replayCorrelated === false) return;
  return replayReadySessionEvents(deps, session, current);
}

/** Called by an authenticated action's retained after-response work, once its
 * session lease has been released. It cannot create an independent worker. */
export async function replayDeferredSessionEvents(deps: ProcessorDeps, sessionId: string): Promise<void> {
  const session = await deps.admin.from("motorist_call_sessions").select("*")
    .eq("organization_id", deps.organizationId).eq("id", sessionId).maybeSingle();
  if (session.error) throw new Error("Deferred call event session unavailable");
  if (session.data) await replayReadySessionEvents(deps, session.data);
}

/**
 * E4.2 — the sweep's customer-terminal drain: hangup only, exact customer leg
 * (`customerTerminalOnly`), `WEBHOOK_LEASE_WAIT_MS`, 8 s deadline, no nested
 * maintenance. Called from retained after-response work or the cron, never
 * from inside an ownership scope and never from `calls/active`.
 */
export async function drainCustomerTerminal(deps: ProcessorDeps, session: SessionRow): Promise<void> {
  await replayReadySessionEvents({ ...deps, replayCorrelated: false, sweepAfterEvent: false, deferMaintenance: undefined }, session, undefined, true);
}

async function replayReadySessionEvents(deps: ProcessorDeps, session: SessionRow, current?: TelephonyEvent, customerTerminalOnly = false): Promise<void> {
  const deadline = Date.now() + DEFERRED_DRAIN_DEADLINE_MS;
  try {
    if (customerTerminalOnly && !session.customer_leg_id) return;
    let legQuery = deps.admin.from("motorist_call_legs").select("telnyx_call_control_id")
      .eq("organization_id", deps.organizationId).eq("session_id", session.id);
    if (customerTerminalOnly && session.customer_leg_id) legQuery = legQuery.eq("id", session.customer_leg_id).eq("role", "customer");
    const [correlation, legs] = await Promise.all([
      current && !customerTerminalOnly ? deps.admin.from("motorist_telnyx_webhook_events").select("*")
        .eq("organization_id", deps.organizationId).eq("retry_state", "awaiting_correlation")
        .neq("event_id", current.id).order("received_at", { ascending: true }).limit(20) : { data: [], error: null },
      legQuery,
    ]);
    if (correlation.error || legs.error) throw new Error(correlation.error?.message ?? legs.error!.message);
    const controlIds = new Set((legs.data ?? []).map(leg => leg.telnyx_call_control_id));
    // A stop/answer can lose the lease race after exact correlation is already
    // known. Draining that ready ledger entry after the owner releases avoids
    // waiting for provider exponential redelivery or the five-minute cron.
    // A shared provider session ID is never enough to select another leg.
    const deferred = controlIds.size ? await deps.admin.from("motorist_telnyx_webhook_events").select("*")
      .eq("organization_id", deps.organizationId).eq("retry_state", "deferred")
      .in("call_control_id", [...controlIds]).in("event_type", customerTerminalOnly ? ["call.hangup"] : DEFERRED_DRAIN_TYPES)
      .lte("next_attempt_at", new Date(nowOf(deps)().getTime() + 5_000).toISOString()).neq("event_id", current?.id ?? "")
      .order("received_at", { ascending: true }).limit(DEFERRED_DRAIN_LIMIT) : { data: [], error: null };
    if (deferred.error) throw new Error(deferred.error.message);
    const occurredAt = (row: { occurred_at: string | null; received_at: string | null }) => Date.parse(row.occurred_at ?? row.received_at ?? "") || 0;
    const rows = [
      ...(deferred.data ?? []).sort((a, b) => (DEFERRED_EVENT_RANK[a.event_type] ?? 9) - (DEFERRED_EVENT_RANK[b.event_type] ?? 9) || occurredAt(a) - occurredAt(b)),
      ...(correlation.data ?? []),
    ];
    let replayed = 0;
    for (const row of rows) {
      const envelope = storedWebhookEnvelope(row);
      const waiting = parseTelnyxEnvelope(envelope);
      // Recheck the parsed payload too: its identity fields can override the
      // ledger columns, and client-state claims alone cannot authorize this path.
      if (customerTerminalOnly && (!waiting || waiting.type !== "call.hangup" ||
        !waiting.callControlId || !controlIds.has(waiting.callControlId))) continue;
      // A shared Telnyx session ID is deliberately insufficient: it can describe
      // a different customer/operator leg. Exact control ID or our signed sid only.
      if (!waiting || waiting.clientState?.sid && waiting.clientState.sid !== session.id ||
        !((waiting.callControlId && controlIds.has(waiting.callControlId)) || current?.callControlId && waiting.callControlId === current.callControlId || waiting.clientState?.sid === session.id)) continue;
      // A terminal fact can be deferred just before the prior owner releases.
      // Retain the SQL backoff instead of missing it until the five-minute cron.
      // This wait owns no session and starts no independent timer/worker.
      const waitMs = row.retry_state === "deferred" && row.next_attempt_at
        ? Math.max(0, Date.parse(row.next_attempt_at) - nowOf(deps)().getTime()) : 0;
      if (Date.now() + waitMs >= deadline) break;
      if (waitMs) await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(waitMs);
      if (Date.now() >= deadline) break;
      const replay = await processTelnyxEvent({ ...deps, ledgerReplay: row.retry_state === "deferred" ? "cron" : "correlation",
        replayCorrelated: false, sweepAfterEvent: false, deferMaintenance: undefined }, envelope);
      if (++replayed >= 2) break;
      if (replay.outcome === "busy" || replay.error?.includes("SessionLeaseBusyError")) break;
    }
  } catch (error) {
    // Current-event completion is already durable; a replay lookup failure is
    // not a failure of the completed provider command. Cron retains the rows.
    deps.logger?.({ level: "warn", scope: "webhook", message: "correlation replay deferred", error: error instanceof Error ? error.message : String(error) });
  }
}
