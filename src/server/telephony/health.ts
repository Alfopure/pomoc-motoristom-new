import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { isDeviceLive } from "@/lib/telephony/device-liveness";

import { STALLED_EVENT_MS, STUCK_SESSION_MS } from "./cron-jobs";
import { TELEPHONY_INCIDENT_JOBS } from "./incidents";
import { DEFAULT_DAILY_LEG_SOFT_CAP, usageDay } from "./usage";
import type { TelnyxConfig } from "./telnyx/env";
import { ACTIVE_SESSION_STATES } from "./state/types";

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
 * `warn` means "look at it today", `fail` means "calls are being lost right
 * now". A check that cannot apply (telephony not configured) is `skipped`, not
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
};

/** A webhook silence longer than this while calls are live means deliveries are lost. */
export const WEBHOOK_SILENCE_WARN_MS = 5 * 60_000;
/** Failed ledger rows in this window are counted; older ones are the prune job's problem. */
export const LEDGER_FAILURE_WINDOW_MS = 24 * 60 * 60_000;
/** Usage above this share of the daily leg cap warns before the cap starts refusing calls. */
export const USAGE_WARN_RATIO = 0.8;

const WORST_FIRST: HealthStatus[] = ["fail", "warn", "skipped", "ok"];

/** The worst check wins, so a single `fail` cannot hide behind a page of `ok`. */
function combine(checks: TelephonyHealthCheck[]): HealthStatus {
  for (const status of WORST_FIRST) {
    if (checks.some((check) => check.status === status)) return status;
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
    status: configured ? "ok" : "skipped",
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
    .select("id, state, updated_at")
    .eq("organization_id", deps.organizationId)
    .in("state", [...ACTIVE_SESSION_STATES]);

  const active = activeSessions.data ?? [];
  const stuck = active.filter((row) => (ageMs(now, row.updated_at) ?? 0) > STUCK_SESSION_MS);
  checks.push({
    key: "sessions",
    status: stuck.length > 0 ? "fail" : "ok",
    detail: {
      active: active.length,
      stuck: stuck.length,
      stuckIds: stuck.slice(0, 10).map((row) => row.id),
      thresholdMs: STUCK_SESSION_MS,
      error: activeSessions.error?.message ?? null,
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
  // Silence only matters while something is on the line: a quiet night is not a
  // fault, but a live call with no events for five minutes is.
  const webhooksStale = active.length > 0 && (silenceMs === null || silenceMs > WEBHOOK_SILENCE_WARN_MS);
  checks.push({
    key: "webhooks",
    status: !configured ? "skipped" : webhooksStale ? "warn" : "ok",
    detail: {
      lastEventAt: lastEvent.data?.received_at ?? null,
      lastEventType: lastEvent.data?.event_type ?? null,
      silenceMs,
      activeSessions: active.length,
      thresholdMs: WEBHOOK_SILENCE_WARN_MS,
      error: lastEvent.error?.message ?? null,
    },
  });

  const since = new Date(now.getTime() - LEDGER_FAILURE_WINDOW_MS).toISOString();
  const failed = await deps.admin
    .from("motorist_telnyx_webhook_events")
    .select("event_id")
    .eq("organization_id", deps.organizationId)
    .eq("status", "failed")
    .gte("received_at", since);
  const queued = await deps.admin
    .from("motorist_telnyx_webhook_events")
    .select("event_id, claimed_at")
    .eq("organization_id", deps.organizationId)
    .eq("status", "queued");

  const stalled = (queued.data ?? []).filter((row) => (ageMs(now, row.claimed_at) ?? 0) > STALLED_EVENT_MS);
  const failedCount = failed.data?.length ?? 0;
  checks.push({
    key: "ledger",
    // Stalled claims are re-driven by the replay job within one cron tick, so
    // they warn; a failed row has exhausted its attempts and stays lost.
    status: failedCount > 0 ? "fail" : stalled.length > 0 ? "warn" : "ok",
    detail: {
      failed24h: failedCount,
      failedIds: (failed.data ?? []).slice(0, 10).map((row) => row.event_id),
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
    status: openIncidents.length > 0 ? "fail" : "ok",
    detail: {
      open: openIncidents.length,
      jobs: openIncidents.map((row) => ({ job: row.job_name, failures: row.consecutive_failures, openedAt: row.opened_at, error: row.last_error_safe })),
      error: incidents.error?.message ?? null,
    },
  });

  const cap = settings.data?.daily_leg_soft_cap ?? DEFAULT_DAILY_LEG_SOFT_CAP;
  const usage = await deps.admin
    .from("motorist_telephony_daily_usage")
    .select("legs, minutes, sms_count")
    .eq("organization_id", deps.organizationId)
    .eq("day", usageDay(now))
    .maybeSingle();

  const legs = usage.data?.legs ?? 0;
  const ratio = cap > 0 ? legs / cap : 0;
  checks.push({
    key: "usage",
    status: ratio >= 1 ? "fail" : ratio >= USAGE_WARN_RATIO ? "warn" : "ok",
    detail: {
      day: usageDay(now),
      legs,
      minutes: usage.data?.minutes ?? 0,
      sms: usage.data?.sms_count ?? 0,
      dailyLegSoftCap: cap,
      ratio: Number(ratio.toFixed(3)),
      error: usage.error?.message ?? null,
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
    status: "ok",
    detail: {
      total: devices.data?.length ?? 0,
      live: live.length,
      error: devices.error?.message ?? null,
    },
  });

  return { status: combine(checks), checkedAt: now.toISOString(), organizationId: deps.organizationId, checks };
}
