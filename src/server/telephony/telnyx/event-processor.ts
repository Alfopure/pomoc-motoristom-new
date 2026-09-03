import type { SupabaseClient } from "@supabase/supabase-js";

import type { CallerMatch } from "@/data/dispatch-types";
import type { Database } from "@/lib/supabase/database.types";

import { recordTelephonyIncident, TELEPHONY_INCIDENT_JOBS } from "../incidents";
import { normalizeE164 } from "../phone/normalize-e164";
import { sweepOverdueRingSteps } from "../routing/ring-plan";
import { effectsDeps, runSessionEvent, type SessionRunnerDeps } from "../session-runner";
import { recordCallEvent, type CommandOutcome } from "../state/effects";
import { classifyEventType, parseTelnyxEnvelope, type EventClass } from "../state/events";
import { toJson, type LineRow, type SessionRow, type TelephonyEvent } from "../state/types";
import { claimWebhookEvent, markWebhookEventFailed, markWebhookEventProcessed, type WebhookClaim } from "./webhook-ledger";

/**
 * Telnyx webhook processor (design §2.3).
 *
 * Signature verification happens in the route; this module does everything
 * after it: connection-id check, control/bookkeeping classification, claim
 * ledger, session resolution (creating the session for an inbound
 * `call.initiated`), the per-session pipeline and the ledger bookkeeping.
 *
 * Response policy: control events always get 200 once compensation has been
 * attempted (Telnyx retries are not a real-time recovery path); bookkeeping
 * failures return 500 so Telnyx retries them later.
 */

type AdminClient = SupabaseClient<Database>;

export type ProcessorDeps = SessionRunnerDeps & {
  /** Run the overdue-step sweep after each control event (design §2.3 item 9a). */
  sweepAfterEvent?: boolean;
  /** Sessions the inline sweep may re-drive (default `INLINE_SWEEP_LIMIT`). */
  sweepLimit?: number;
  /** Wall-clock budget shared by the event and its inline sweep. */
  sweepBudgetMs?: number;
};

/** Inline sweep caps: the webhook route runs with `maxDuration = 10`. */
export const INLINE_SWEEP_LIMIT = 2;
export const INLINE_SWEEP_BUDGET_MS = 4_000;

export type ProcessorOutcome = "processed" | "ignored" | "duplicate" | "busy" | "failed" | "malformed" | "unverified_connection" | "unknown_session";

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
    if (bySession.data) return bySession.data;
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
  const line = await findLine(deps, deps.environment, event.to);
  const callerNumber = event.from ? (normalizeE164(event.from) ?? event.from) : null;
  const calledNumber = event.to ? (normalizeE164(event.to) ?? event.to) : null;

  let match: { top: CallerMatch | null; count: number; degraded: boolean } | null = null;
  if (callerNumber && deps.findCallerMatches) {
    try {
      const found = await deps.findCallerMatches(callerNumber);
      match = { top: found.matches[0] ?? null, count: found.matches.length, degraded: found.degraded };
    } catch (error) {
      deps.logger?.({ level: "warn", scope: "processor", message: "caller match failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const caseId = match?.top && match.top.type === "open_case" && match.top.caseId ? match.top.caseId : null;

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
      case_id: caseId,
      caller_number: callerNumber,
      called_number: calledNumber,
      started_at: event.occurredAt ?? now.toISOString(),
      metadata: toJson({ match, line_label: line?.label ?? null, partner_name: line?.partner_name ?? null, environment: deps.environment }),
    })
    .select("*")
    .single();

  let session: SessionRow;
  if (inserted.error) {
    if (inserted.error.code !== "23505" || !event.callSessionId) throw new Error(`session insert failed: ${inserted.error.message}`);
    const existing = await admin.from("motorist_call_sessions").select("*").eq("telnyx_session_id", event.callSessionId).maybeSingle();
    if (existing.error || !existing.data) throw new Error(`session insert conflict but no row: ${existing.error?.message ?? "missing"}`);
    session = existing.data;
  } else {
    session = inserted.data;
  }

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
}

export async function processTelnyxEvent(deps: ProcessorDeps, envelope: unknown): Promise<ProcessorResult> {
  const now = nowOf(deps);
  const started = now().getTime();
  const done = (partial: Omit<ProcessorResult, "ms">): ProcessorResult => ({ ...partial, ms: now().getTime() - started });
  const base = { eventId: null, type: null, eventClass: null, sessionId: null, claim: null, commands: [], notes: [], error: null } satisfies Omit<ProcessorResult, "status" | "outcome" | "ms">;

  const event = parseTelnyxEnvelope(envelope);
  if (!event) return done({ ...base, status: 400, outcome: "malformed" });
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
    payload: toJson(event.payload),
    organizationId: deps.organizationId,
    callSessionId: event.callSessionId,
    callLegId: event.callLegId,
    callControlId: event.callControlId,
    connectionId: event.connectionId,
    occurredAt: event.occurredAt,
  });
  if (claim.outcome !== "claimed") {
    return done({ ...identity, claim, status: 200, outcome: claim.outcome });
  }

  const effects = effectsDeps(deps);
  let session: SessionRow | null = null;
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
    if (!session && event.type === "call.initiated" && event.direction === "incoming" && eventClass === "control" && !fromCredentialConnection) {
      session = await createInboundSession(deps, event);
    }

    if (!session) {
      await recordCallEvent(effects, { session: null, event, handledStatus: "ignored", stateBefore: null, stateAfter: null, notes: ["unknown session"], commands: [] });
      await markWebhookEventProcessed(deps.admin, event.id, { now, claimedAt: claim.claimedAt, logger: deps.logger });
      deps.logger?.({ scope: "webhook", eventId: event.id, type: event.type, outcome: "unknown_session", callControlId: event.callControlId });
      return done({ ...identity, claim, status: 200, outcome: "unknown_session", notes: ["unknown session"] });
    }

    if (eventClass === "bookkeeping") {
      await recordCallEvent(effects, { session, event, handledStatus: "processed", stateBefore: session.state, stateAfter: session.state, notes: ["bookkeeping"], commands: [] });
      await markWebhookEventProcessed(deps.admin, event.id, { now, claimedAt: claim.claimedAt, logger: deps.logger });
      return done({ ...identity, claim, sessionId: session.id, status: 200, outcome: "processed", notes: ["bookkeeping"] });
    }

    const run = await runSessionEvent(deps, session.id, event);
    if (run.outcome === "ignored") {
      await markWebhookEventProcessed(deps.admin, event.id, { now, claimedAt: claim.claimedAt, logger: deps.logger });
      logResult(deps, event, claim, session.id, "ignored", [], started, now);
      return done({ ...identity, claim, sessionId: session.id, status: 200, outcome: "ignored", notes: [run.reason] });
    }

    if (run.apply.failed) {
      await markWebhookEventFailed(deps.admin, event.id, run.apply.failure?.error ?? "command failed", { claimedAt: claim.claimedAt, logger: deps.logger });
      logResult(deps, event, claim, session.id, "failed", run.commands, started, now);
      await maybeSweep(deps, started);
      return done({ ...identity, claim, sessionId: session.id, status: 200, outcome: "failed", commands: run.commands, notes: run.apply.notes, error: run.apply.failure?.error ?? null });
    }

    await markWebhookEventProcessed(deps.admin, event.id, { now, claimedAt: claim.claimedAt, logger: deps.logger });
    logResult(deps, event, claim, session.id, "processed", run.commands, started, now);
    await maybeSweep(deps, started);
    return done({ ...identity, claim, sessionId: session.id, status: 200, outcome: "processed", commands: run.commands, notes: run.apply.notes });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await recordTelephonyIncident(deps.admin, { job: TELEPHONY_INCIDENT_JOBS.webhook, error, context: { eventId: event.id, type: event.type, sessionId: session?.id ?? null } });
    try {
      await markWebhookEventFailed(deps.admin, event.id, error, { claimedAt: claim.claimedAt, logger: deps.logger });
    } catch (ledgerError) {
      deps.logger?.({ level: "error", scope: "webhook", eventId: event.id, message: "ledger update failed", error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError) });
    }
    deps.logger?.({ level: "error", scope: "webhook", eventId: event.id, type: event.type, sessionId: session?.id ?? null, outcome: "failed", error: message, ms: now().getTime() - started });
    // 200 is only safe once the event is attached to a session: compensation has
    // then run and a Telnyx retry is not a recovery path. A failure before that
    // (session creation, session lookup) dropped the call, so ask for a retry.
    const status = eventClass === "control" && session ? 200 : 500;
    return done({ ...identity, claim, sessionId: session?.id ?? null, status, outcome: "failed", error: message });
  }
}

async function maybeSweep(deps: ProcessorDeps, startedAt: number): Promise<void> {
  if (deps.sweepAfterEvent === false) return;
  // The route budget is `maxDuration = 10`; the webhook has already spent part of
  // it. Sweep at most a couple of sessions inline and leave the exhaustive pass
  // to `/api/telephony/cron` (unbounded) and the throttled `calls/active` trigger.
  const spent = nowOf(deps)().getTime() - startedAt;
  const budgetMs = Math.max(0, (deps.sweepBudgetMs ?? INLINE_SWEEP_BUDGET_MS) - spent);
  if (budgetMs <= 0) return;
  try {
    await sweepOverdueRingSteps({
      admin: deps.admin,
      organizationId: deps.organizationId,
      now: nowOf(deps),
      limit: deps.sweepLimit ?? INLINE_SWEEP_LIMIT,
      budgetMs,
      // The current session is included on purpose: when every dial of a step failed the fan-out
      // backdates `step_deadline_at` and no Telnyx event will ever arrive to advance it.
      runSessionEvent: (sessionId, event) => runSessionEvent(deps, sessionId, event),
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
    claim: `${claim.outcome}#${claim.attempts}`,
    outcome,
    ms: now().getTime() - started,
    commands: commands.map((command) => `${command.kind}${command.ok ? "" : "!"}`),
  });
}
