import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { isDeviceLive } from "@/lib/telephony/device-liveness";
import { getCallInterruptionHealth, type CallInterruptionConfiguration } from "./call-interruptions";

import { STALLED_EVENT_MS, STUCK_SESSION_MS } from "./cron-jobs";
import { TELEPHONY_INCIDENT_JOBS } from "./incidents";
import { getRecentConnectionOutcomes } from "./connection-outcomes";
import { DEFAULT_DAILY_LEG_SOFT_CAP, usageDay } from "./usage";
import type { TelnyxConfig } from "./telnyx/env";
import { ACTIVE_SESSION_STATES, readMeta } from "./state/types";
import { PROGRESS_WARN_MS, sessionProgressIssue, type ProviderVerification } from "./health-progress";

/**
 * Operational health of the telephony stack, read straight from Postgres.
 *
 * `recordTelephonyIncident` has always promised a surface where an operator can
 * see whether the exchange is actually working; this is it. Everything here is
 * a plain select, so the check answers even when Telnyx is unreachable — which
 * is exactly the moment somebody looks at it.
 *
 * The checks answer three different questions, and the runbook treats them
 * differently:
 *   - is the wiring there at all (`configuration`, kill switches),
 *   - is the event pipeline moving (`webhooks`, `ledger`, `sessions`),
 *   - is anything about to hit a limit (`usage`, `devices`).
 *
 * `warn` needs investigation; `fail` is a serious unresolved condition. The
 * result of any individual call requires its own evidence. A check that cannot apply is `skipped`, not
 * `ok`, so a half-provisioned environment never reports healthy.
 */

type AdminClient = SupabaseClient<Database>;

export type HealthStatus = "ok" | "warn" | "fail" | "skipped";

export type TelephonyHealthCheck = {
  key: string;
  status: HealthStatus;
  detail: Record<string, unknown>;
};

export type TelephonyHealthReport = {
  status: HealthStatus;
  checkedAt: string;
  organizationId: string;
  checks: TelephonyHealthCheck[];
};

export type TelephonyHealthDeps = {
  admin: AdminClient;
  organizationId: string;
  config: Pick<TelnyxConfig, "configured">;
  now?: () => Date;
  /** Read-only facts from this cron tick's existing provider reconciliation. */
  providerVerification?: ProviderVerification;
  /** Test seam; the default requires explicit activation and a stable deployment. */
  interruptionConfiguration?: CallInterruptionConfiguration | null;
};

/** Compatibility name: now a per-interaction overdue grace, never global silence. */
export const WEBHOOK_SILENCE_WARN_MS = PROGRESS_WARN_MS;
/** Failed ledger rows in this window are counted; older ones are the prune job's problem. */
export const LEDGER_FAILURE_WINDOW_MS = 24 * 60 * 60_000;
/** Usage above this share of the daily leg cap warns before the cap starts refusing calls. */
export const USAGE_WARN_RATIO = 0.8;

const WORST_FIRST: HealthStatus[] = ["fail", "warn", "skipped", "ok"];

/** The worst check wins, so a single `fail` cannot hide behind a page of `ok`. */
function combine(checks: TelephonyHealthCheck[]): HealthStatus {
  for (const status of WORST_FIRST) {
    if (checks.some((check) => check.status === status && !(["provider", "interruptions"].includes(check.key) && status === "skipped"))) return status;
  }
  return "ok";
}

function ageMs(now: Date, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, now.getTime() - at);
}

export async function getTelephonyHealth(deps: TelephonyHealthDeps): Promise<TelephonyHealthReport> {
  const now = deps.now?.() ?? new Date();
  const configured = deps.config.configured;
  const checks: TelephonyHealthCheck[] = [];

  const settings = await deps.admin
    .from("motorist_telephony_settings")
    .select("live_calls_enabled, sms_live_sends, daily_leg_soft_cap, park_max_minutes")
    .eq("organization_id", deps.organizationId)
    .maybeSingle();

  checks.push({
    key: "configuration",
    // Missing credentials is not a failure on a preview deployment that never
    // had them; it is the reason every other check reports `skipped`.
    status: settings.error ? "warn" : configured ? "ok" : "skipped",
    detail: {
      configured,
      liveCallsEnabled: settings.data?.live_calls_enabled ?? null,
      smsLiveSends: settings.data?.sms_live_sends ?? null,
      settingsRow: Boolean(settings.data),
      error: settings.error?.message ?? null,
    },
  });

  const activeSessions = await deps.admin
    .from("motorist_call_sessions")
    .select("id, state, metadata, started_at, created_at, parked_at, answered_at, answered_by_profile_id, customer_leg_id, conference_id")
    .eq("organization_id", deps.organizationId)
    .in("state", [...ACTIVE_SESSION_STATES]);

  const active = activeSessions.data ?? [];
  const needsLegEvidence = active.filter(row => row.state === "talking" && !readMeta(row).recording?.connection && !row.conference_id);
  const legEvidence = needsLegEvidence.length ? await deps.admin.from("motorist_call_legs")
    .select("id, session_id, role, profile_id, answered_at, bridged_at, telnyx_call_control_id").eq("organization_id", deps.organizationId)
    .in("session_id", needsLegEvidence.map(row => row.id)).is("ended_at", null).order("id").limit(201)
    : { data: [], error: null };
  const legError = legEvidence.error?.message ?? ((legEvidence.data?.length ?? 0) > 200 ? "connection_evidence_truncated" : null);
  const progress = active.flatMap((row) => {
    const issue = sessionProgressIssue(row, now, settings.error ? Infinity : settings.data?.park_max_minutes ?? 30,
      legError ? undefined : (legEvidence.data ?? []).filter(leg => leg.session_id === row.id));
    return issue ? [issue] : [];
  });
  const overdue = progress.filter((issue) => issue.overdueMs > PROGRESS_WARN_MS);
  const stuck = progress.filter((issue) => issue.overdueMs > STUCK_SESSION_MS);
  checks.push({
    key: "sessions",
    status: stuck.length > 0 ? "fail" : activeSessions.error || legError ? "warn" : "ok",
    detail: {
      active: active.length,
      stuck: stuck.length,
      stuckIds: stuck.map((row) => row.sessionId),
      entries: stuck,
      thresholdMs: STUCK_SESSION_MS,
      error: activeSessions.error?.message ?? legError,
    },
  });

  const lastEvent = await deps.admin
    .from("motorist_telnyx_webhook_events")
    .select("event_id, event_type, received_at")
    .eq("organization_id", deps.organizationId)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const silenceMs = ageMs(now, lastEvent.data?.received_at ?? null);
  checks.push({
    key: "webhooks",
    status: !configured ? "skipped" : overdue.length || activeSessions.error || legError || lastEvent.error ? "warn" : "ok",
    detail: {
      lastEventAt: lastEvent.data?.received_at ?? null,
      lastEventType: lastEvent.data?.event_type ?? null,
      silenceMs,
      activeSessions: active.length,
      thresholdMs: WEBHOOK_SILENCE_WARN_MS,
      // Latest org event is context only; another call cannot hide this one.
      sessionIds: overdue.map((entry) => entry.sessionId),
      entries: overdue,
      error: activeSessions.error?.message ?? legError ?? lastEvent.error?.message ?? null,
    },
  });

  const verification = deps.providerVerification;
  const observations = verification?.entries ?? [];
  const observedSessions = new Set(observations.map((entry) => entry.sessionId));
  const uncertain = observations.some((entry) => entry.verdict === "unknown" || entry.verdict === "unavailable");
  const mismatch = observations.some((entry) => entry.verdict === "ended");
  checks.push({
    key: "provider",
    status: !configured || !verification || verification.skipped ? "skipped"
      : observations.some((entry) => entry.verdict === "ended" && entry.reconciled === false) ? "fail"
        : verification.error || uncertain || mismatch || verification.remaining > 0 ? "warn" : "ok",
    detail: {
      checkedAt: verification?.checkedAt ?? null,
      entries: observations,
      checkedLegs: observations.filter(entry => entry.legId && entry.verdict !== "unavailable").length,
      sessionIds: [...observedSessions],
      unverifiedSessionIds: active.filter((row) => !observedSessions.has(row.id)).map((row) => row.id),
      remaining: verification?.remaining ?? 0,
      reason: verification?.skipped ?? (!verification ? "not_checked" : "reconciliation_observations"),
      error: verification?.error ?? null,
    },
  });

  const since = new Date(now.getTime() - LEDGER_FAILURE_WINDOW_MS).toISOString();
  const connections = await getRecentConnectionOutcomes({ admin: deps.admin, organizationId: deps.organizationId, since });
  const pendingConnections = connections.entries.filter((entry) => entry.outcome === "pending" && now.getTime() - Date.parse(entry.failedAt) >= 30_000);
  const unconfirmedEnded = connections.entries.filter((entry) => entry.outcome === "ended_without_confirmation");
  const unknownConnections = connections.entries.filter((entry) => entry.outcome === "unknown");
  checks.push({ key: "connections", status: !configured ? "skipped" : pendingConnections.length ? "fail" : unconfirmedEnded.length || unknownConnections.length || connections.error || connections.truncated ? "warn" : "ok",
    detail: { pending: pendingConnections.length, endedWithoutConfirmation: unconfirmedEnded.length,
      confirmedAfterFailure: connections.entries.filter((entry) => entry.outcome === "confirmed_after_failure").length,
      commandsRecovered: connections.entries.filter((entry) => entry.outcome === "command_recovered").length, unknown: unknownConnections.length,
      entries: connections.entries, truncated: connections.truncated, error: connections.error } });
  const failed = await deps.admin
    .from("motorist_telnyx_webhook_events")
    .select("event_id")
    .eq("organization_id", deps.organizationId)
    .eq("status", "failed")
    .gte("received_at", since)
    .order("received_at", { ascending: false }).limit(201);
  const queued = await deps.admin
    .from("motorist_telnyx_webhook_events")
    .select("event_id, claimed_at")
    .eq("organization_id", deps.organizationId)
    .eq("status", "queued").order("received_at", { ascending: false }).limit(201);

  const stalled = (queued.data ?? []).filter((row) => (ageMs(now, row.claimed_at) ?? 0) > STALLED_EVENT_MS);
  const failedCount = failed.data?.length ?? 0;
  checks.push({
    key: "ledger",
    // Failed rows need attention even if a bounded replay can still recover
    // them; stalled claims normally get another attempt in the next cron tick.
    status: failedCount > 0 ? "fail" : stalled.length > 0 || (queued.data?.length ?? 0) > 200 || failed.error || queued.error ? "warn" : "ok",
    detail: {
      failed24h: failedCount,
      failedIds: (failed.data ?? []).map((row) => row.event_id),
      truncated: (failed.data?.length ?? 0) > 200 || (queued.data?.length ?? 0) > 200,
      queued: queued.data?.length ?? 0,
      stalled: stalled.length,
      error: failed.error?.message ?? queued.error?.message ?? null,
    },
  });

  const incidentJobs = Object.values(TELEPHONY_INCIDENT_JOBS);
  const incidents = await deps.admin
    .from("motorist_job_incidents")
    .select("job_name, consecutive_failures, opened_at, last_error_safe")
    .eq("status", "open")
    .in("job_name", [...incidentJobs]);

  const openIncidents = incidents.data ?? [];
  checks.push({
    key: "incidents",
    status: openIncidents.length > 0 ? "fail" : incidents.error ? "warn" : "ok",
    detail: {
      open: openIncidents.length,
      jobs: openIncidents.map((row) => ({ job: row.job_name, failures: row.consecutive_failures, openedAt: row.opened_at, error: row.last_error_safe })),
      error: incidents.error?.message ?? null,
    },
  });

  const cap = settings.error ? null : settings.data?.daily_leg_soft_cap ?? DEFAULT_DAILY_LEG_SOFT_CAP;
  const usage = await deps.admin
    .from("motorist_telephony_daily_usage")
    .select("legs, minutes, sms_count")
    .eq("organization_id", deps.organizationId)
    .eq("day", usageDay(now))
    .maybeSingle();

  const legs = usage.data?.legs ?? 0;
  const ratio = cap !== null && cap > 0 ? legs / cap : 0;
  checks.push({
    key: "usage",
    status: ratio >= 1 ? "fail" : ratio >= USAGE_WARN_RATIO || usage.error || settings.error ? "warn" : "ok",
    detail: {
      day: usageDay(now),
      legs,
      minutes: usage.data?.minutes ?? 0,
      sms: usage.data?.sms_count ?? 0,
      dailyLegSoftCap: cap,
      ratio: cap === null ? null : Number(ratio.toFixed(3)),
      error: usage.error?.message ?? settings.error?.message ?? null,
    },
  });

  const devices = await deps.admin
    .from("motorist_operator_devices")
    .select("profile_id, registration_state, device_seen_at")
    .eq("organization_id", deps.organizationId);

  // The same liveness rule the ring engine applies, so this number answers the
  // question an operator actually asks: how many phones would a call reach?
  const live = (devices.data ?? []).filter((row) => isDeviceLive({ deviceSeenAt: row.device_seen_at, registrationState: row.registration_state }, now));
  checks.push({
    key: "devices",
    // Zero live phones is normal outside business hours, so this only ever
    // informs: the ring plan's fallback covers an empty floor.
    status: devices.error ? "warn" : "ok",
    detail: {
      total: devices.data?.length ?? 0,
      live: live.length,
      error: devices.error?.message ?? null,
    },
  });

  checks.push(await getCallInterruptionHealth({ admin: deps.admin, organizationId: deps.organizationId, now, configuration: deps.interruptionConfiguration }));
  return { status: combine(checks), checkedAt: now.toISOString(), organizationId: deps.organizationId, checks };
}
