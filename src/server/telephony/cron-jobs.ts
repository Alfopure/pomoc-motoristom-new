import { randomUUID } from "node:crypto";

import { recordTelephonyIncident, TELEPHONY_INCIDENT_JOBS } from "./incidents";
import { closeOrphanLegs, closeStaleRingAttempts, sweepOverdueRingSteps } from "./routing/ring-plan";
import { runSessionEvent, type SessionRunnerDeps } from "./session-runner";
import { processTelnyxEvent } from "./telnyx/event-processor";
import { ACTIVE_SESSION_STATES, type AppEvent, type SessionRow } from "./state/types";

/**
 * Jobs behind the single allowed Vercel cron (every 5 minutes →
 * `/api/telephony/cron`, guarded by `CRON_SECRET`).
 *
 * 1. `telephony.ring.sweep` — re-drives sessions whose ring step, waiting-room
 *    MOH tick or wrap-up finalisation deadline passed without the expected
 *    webhook (the primary sweeper is the webhook itself; this is the safety net
 *    for calls where every Telnyx delivery was lost).
 * 2. `telephony.sessions.stuck` — detection only: active sessions untouched for
 *    `stuckAfterMs` are reported (and swept when a provider is configured) so
 *    the health surface and the runbook have a number to look at.
 * 3. `telephony.ledger.replay` — re-drives webhook events that were claimed but
 *    never finished (the function died mid-processing, so Telnyx will not send
 *    them again). Without this a single lost invocation leaves a leg open and
 *    its session hanging until the 15-minute stuck sweep, and any effect the
 *    event carried is simply lost.
 * 4. `telephony.ledger.prune` — 30-day retention of processed webhook ledger
 *    rows plus 7-day payload nulling for the noisy bookkeeping event types.
 *    Gated by the `motorist_job_controls` row so it can be switched off.
 */

export const LEDGER_PRUNE_JOB = "telephony.ledger.prune";
export const LEDGER_REPLAY_JOB = "telephony.ledger.replay";
export const RING_SWEEP_JOB = "telephony.ring.sweep";
export const STUCK_SESSION_JOB = "telephony.sessions.stuck";

/** A claimed event untouched for this long is assumed abandoned and re-driven. */
export const STALLED_EVENT_MS = 60_000;
/** Give up on an event after this many attempts so a poison row cannot loop. */
export const MAX_EVENT_ATTEMPTS = 5;
/** Upper bound per cron tick, so one backlog cannot exhaust the function budget. */
export const REPLAY_BATCH_SIZE = 20;

export const LEDGER_RETENTION_DAYS = 30;
export const LEDGER_PAYLOAD_RETENTION_DAYS = 7;
/** Event types whose payload is dropped early (high volume, no forensic value). */
export const LEDGER_PAYLOAD_EVENT_TYPES = ["call.playback.started", "call.playback.ended", "call.cost", "call.speak.started", "call.speak.ended"];
/** An active session untouched for this long is reported as stuck. */
export const STUCK_SESSION_MS = 15 * 60_000;

export type TelephonyCronJobStatus = "ok" | "skipped" | "disabled" | "failed";

export type TelephonyCronJobResult = {
  job: string;
  status: TelephonyCronJobStatus;
  detail: Record<string, unknown>;
  error?: string;
};

export type TelephonyCronSummary = {
  status: "ok" | "degraded";
  checkedAt: string;
  organizationId: string;
  configured: boolean;
  ms: number;
  jobs: TelephonyCronJobResult[];
};

export type TelephonyCronDeps = SessionRunnerDeps & {
  /** Injection seam for tests; defaults to the shared per-session pipeline. */
  runSession?: (sessionId: string, event: AppEvent) => Promise<unknown>;
  ledgerRetentionDays?: number;
  payloadRetentionDays?: number;
  stuckAfterMs?: number;
  stalledEventMs?: number;
  /** Injection seam for tests; defaults to the real webhook processor. */
  replayEvent?: (envelope: unknown) => Promise<unknown>;
};

function nowOf(deps: TelephonyCronDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function sessionRunner(deps: TelephonyCronDeps): (sessionId: string, event: AppEvent) => Promise<unknown> {
  return deps.runSession ?? ((sessionId, event) => runSessionEvent(deps, sessionId, event));
}

export async function runRingSweep(deps: TelephonyCronDeps): Promise<TelephonyCronJobResult> {
  if (!deps.telnyx) {
    return { job: RING_SWEEP_JOB, status: "skipped", detail: { reason: "not_configured" } };
  }
  try {
    const result = await sweepOverdueRingSteps({
      admin: deps.admin,
      organizationId: deps.organizationId,
      now: deps.now ?? (() => new Date()),
      runSessionEvent: sessionRunner(deps),
    });
    if (result.errors.length > 0) {
      await recordTelephonyIncident(deps.admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: new Error(result.errors[0].error), context: { job: RING_SWEEP_JOB, sessionId: result.errors[0].sessionId } });
    }
    // Legs whose `call.hangup` never arrived would otherwise count against
    // `max_concurrent_legs` forever and silently stop inbound ringing.
    const orphans = await closeOrphanLegs(deps.admin, { organizationId: deps.organizationId, now: nowOf(deps) });
    if (orphans.length > 0) deps.logger?.({ level: "warn", scope: "cron", job: RING_SWEEP_JOB, orphanLegsClosed: orphans.length });
    // A leaked `offered` attempt keeps its operator out of every ring plan
    // (global partial unique index), so it must be terminalised too.
    const attempts = await closeStaleRingAttempts(deps.admin, { organizationId: deps.organizationId, now: nowOf(deps) });
    if (attempts.length > 0) deps.logger?.({ level: "warn", scope: "cron", job: RING_SWEEP_JOB, staleAttemptsClosed: attempts.length });
    return {
      job: RING_SWEEP_JOB,
      status: result.errors.length > 0 ? "failed" : "ok",
      detail: {
        checked: result.checked,
        swept: result.swept.length,
        deferred: result.deferred.length,
        orphanLegsClosed: orphans.length,
        staleAttemptsClosed: attempts.length,
        errors: result.errors,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordTelephonyIncident(deps.admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error, context: { job: RING_SWEEP_JOB } });
    return { job: RING_SWEEP_JOB, status: "failed", detail: {}, error: message };
  }
}

export async function detectStuckSessions(deps: TelephonyCronDeps): Promise<TelephonyCronJobResult> {
  const now = nowOf(deps);
  const cutoff = new Date(now.getTime() - (deps.stuckAfterMs ?? STUCK_SESSION_MS)).toISOString();
  const { data, error } = await deps.admin
    .from("motorist_call_sessions")
    .select("*")
    .eq("organization_id", deps.organizationId)
    .in("state", [...ACTIVE_SESSION_STATES])
    .lt("updated_at", cutoff);
  if (error) return { job: STUCK_SESSION_JOB, status: "failed", detail: {}, error: error.message };

  const stuck = (data ?? []) as SessionRow[];
  const swept: string[] = [];
  const errors: Array<{ sessionId: string; error: string }> = [];
  if (deps.telnyx) {
    const run = sessionRunner(deps);
    for (const session of stuck) {
      try {
        // The 15-minute cutoff was evaluated on the pre-lease row, so the
        // verdict travels with the event (the lease write is not activity).
        await run(session.id, { kind: "app", id: `cron-stuck:${session.id}:${randomUUID()}`, type: "sweep", actorProfileId: null, occurredAt: now.toISOString(), stale: true });
        swept.push(session.id);
      } catch (sweepError) {
        errors.push({ sessionId: session.id, error: sweepError instanceof Error ? sweepError.message : String(sweepError) });
      }
    }
  }
  if (stuck.length > 0) {
    deps.logger?.({ level: "warn", scope: "cron", job: STUCK_SESSION_JOB, stuck: stuck.length, sessions: stuck.map((session) => ({ id: session.id, state: session.state, updatedAt: session.updated_at })) });
  }
  return {
    job: STUCK_SESSION_JOB,
    status: errors.length > 0 ? "failed" : "ok",
    detail: { stuck: stuck.length, swept: swept.length, cutoff, sessions: stuck.map((session) => ({ id: session.id, state: session.state, updatedAt: session.updated_at })), errors },
  };
}

/**
 * Re-drives webhook events that were claimed but never finished.
 *
 * Telnyx only redelivers on a 5xx, and the webhook route answers 200 for every
 * control event once compensation has run — so an invocation that dies between
 * the claim and the final `processed` mark takes that event's effect with it.
 * The ledger row is the record that it happened, and this job replays it.
 */
export async function replayStalledWebhookEvents(deps: TelephonyCronDeps): Promise<TelephonyCronJobResult> {
  if (!deps.telnyx) return { job: LEDGER_REPLAY_JOB, status: "skipped", detail: { reason: "telephony_not_configured" } };

  const now = nowOf(deps);
  const cutoff = new Date(now.getTime() - (deps.stalledEventMs ?? STALLED_EVENT_MS)).toISOString();
  const { data, error } = await deps.admin
    .from("motorist_telnyx_webhook_events")
    .select("event_id, event_type, payload, occurred_at, attempts")
    .eq("organization_id", deps.organizationId)
    .in("status", ["queued", "failed"])
    .lt("received_at", cutoff)
    .lt("attempts", MAX_EVENT_ATTEMPTS)
    .order("received_at", { ascending: true })
    .limit(REPLAY_BATCH_SIZE);
  if (error) return { job: LEDGER_REPLAY_JOB, status: "failed", detail: {}, error: error.message };

  const rows = data ?? [];
  const replayed: string[] = [];
  const errors: Array<{ eventId: string; error: string }> = [];
  const process = deps.replayEvent ?? ((envelope: unknown) => processTelnyxEvent(deps, envelope));

  for (const row of rows) {
    // The ledger stores the inner payload; rebuild the envelope the processor parses.
    const envelope = { data: { id: row.event_id, event_type: row.event_type, occurred_at: row.occurred_at, payload: row.payload } };
    try {
      await process(envelope);
      replayed.push(row.event_id);
    } catch (replayError) {
      errors.push({ eventId: row.event_id, error: replayError instanceof Error ? replayError.message : String(replayError) });
    }
  }

  if (rows.length > 0) {
    deps.logger?.({ level: "warn", scope: "cron", job: LEDGER_REPLAY_JOB, stalled: rows.length, replayed: replayed.length, failed: errors.length });
  }
  if (errors.length > 0) {
    await recordTelephonyIncident(deps.admin, {
      job: TELEPHONY_INCIDENT_JOBS.webhook,
      error: new Error(errors[0].error),
      context: { job: LEDGER_REPLAY_JOB, stalled: rows.length, replayed: replayed.length, eventId: errors[0].eventId },
    });
  }

  return {
    job: LEDGER_REPLAY_JOB,
    status: errors.length > 0 ? "failed" : "ok",
    detail: { stalled: rows.length, replayed: replayed.length, errors },
    error: errors.length > 0 ? errors[0].error : undefined,
  };
}

export async function pruneWebhookLedger(deps: TelephonyCronDeps): Promise<TelephonyCronJobResult> {
  const control = await deps.admin.from("motorist_job_controls").select("enabled").eq("job_name", LEDGER_PRUNE_JOB).maybeSingle();
  if (control.error) return { job: LEDGER_PRUNE_JOB, status: "failed", detail: {}, error: control.error.message };
  if (control.data && control.data.enabled === false) {
    return { job: LEDGER_PRUNE_JOB, status: "disabled", detail: { reason: "job_control_disabled" } };
  }

  const now = nowOf(deps);
  const day = 24 * 60 * 60 * 1000;
  const deleteBefore = new Date(now.getTime() - (deps.ledgerRetentionDays ?? LEDGER_RETENTION_DAYS) * day).toISOString();
  const payloadBefore = new Date(now.getTime() - (deps.payloadRetentionDays ?? LEDGER_PAYLOAD_RETENTION_DAYS) * day).toISOString();

  const deleted = await deps.admin
    .from("motorist_telnyx_webhook_events")
    .delete()
    .eq("organization_id", deps.organizationId)
    .eq("status", "processed")
    .lt("received_at", deleteBefore)
    .select("event_id");
  if (deleted.error) return { job: LEDGER_PRUNE_JOB, status: "failed", detail: {}, error: deleted.error.message };

  const nulled = await deps.admin
    .from("motorist_telnyx_webhook_events")
    .update({ payload: null })
    .eq("organization_id", deps.organizationId)
    .in("event_type", LEDGER_PAYLOAD_EVENT_TYPES)
    .lt("received_at", payloadBefore)
    .not("payload", "is", null)
    .select("event_id");
  if (nulled.error) return { job: LEDGER_PRUNE_JOB, status: "failed", detail: { deleted: (deleted.data ?? []).length }, error: nulled.error.message };

  return { job: LEDGER_PRUNE_JOB, status: "ok", detail: { deleted: (deleted.data ?? []).length, payloadsCleared: (nulled.data ?? []).length, deleteBefore, payloadBefore } };
}

export async function runTelephonyCronJobs(deps: TelephonyCronDeps): Promise<TelephonyCronSummary> {
  const started = nowOf(deps).getTime();
  const jobs = [await runRingSweep(deps), await replayStalledWebhookEvents(deps), await detectStuckSessions(deps), await pruneWebhookLedger(deps)];
  const checkedAt = nowOf(deps);
  return {
    status: jobs.some((job) => job.status === "failed") ? "degraded" : "ok",
    checkedAt: checkedAt.toISOString(),
    organizationId: deps.organizationId,
    configured: deps.config.configured,
    ms: checkedAt.getTime() - started,
    jobs,
  };
}
