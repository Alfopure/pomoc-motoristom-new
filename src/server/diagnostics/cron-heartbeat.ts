import "server-only";

import { assertAppEnvironment, isTestLiveDeployment, PRODUCTION_SUPABASE_REF, resolveAppEnvironment } from "@/lib/app-environment";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createSupabaseAdminClient>;
type Environment = Record<string, string | undefined>;
type ExecutionStatus = "ok" | "auxiliary_degraded" | "degraded" | "failed";

export const CRON_HEARTBEAT_LIMITS = { ioMs: 1_000, maxAgeMs: 10 * 60_000, maxRuntimeMs: 120_000 } as const;
const PRODUCTION_PROJECT = "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG";
const validRelease = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

/** This marker belongs to the existing Vercel cron, not to an additional worker. */
export function cronHeartbeatConfiguration(env: Environment = process.env): { instanceId: string; release: string } | null {
  try {
    assertAppEnvironment(env);
    const environment = resolveAppEnvironment(env);
    if (env.VERCEL_ENV !== "production" || env.MOTORIST_APP_ENV !== environment || !validRelease(env.VERCEL_GIT_COMMIT_SHA)) return null;
    if (environment === "test") {
      if (!isTestLiveDeployment(env)) return null;
    } else if (environment === "production") {
      if (env.VERCEL_PROJECT_ID !== PRODUCTION_PROJECT || env.VERCEL_GIT_COMMIT_REF !== "main" ||
          env.APP_BASE_URL !== "https://dispecing.linkapomoci.sk" ||
          ![env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL].includes(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`)) return null;
    } else return null;
    return { instanceId: `dispatch-cron:${environment}:${env.VERCEL_PROJECT_ID}`, release: env.VERCEL_GIT_COMMIT_SHA };
  } catch { return null; }
}

/** The abort cancels PostgREST retries; the race also bounds a stalled transport. */
async function bounded<T>(work: (signal: AbortSignal) => PromiseLike<T>): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, CRON_HEARTBEAT_LIMITS.ioMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * One primary-key upsert after all cron jobs finish. No per-run rows, customer
 * data, provider call, or schema change. An unconfirmed write must not alter
 * business execution; an old marker will instead fail the readiness check.
 * The existing schedule is 300 s and its Vercel maxDuration is 120 s, so normal
 * successive scheduled runs cannot overlap. This is not a lock for manually
 * concurrent cron requests; acceptance observes the scheduled writer only.
 */
export async function recordCronHeartbeat(admin: Admin, startedAt: number, executionStatus: ExecutionStatus, env: Environment = process.env): Promise<boolean> {
  if (env.DIAGNOSTICS_CRON_HEARTBEAT_ENABLED !== "true") return false;
  const configuration = cronHeartbeatConfiguration(env);
  const completedAt = Date.now();
  if (!configuration || !Number.isFinite(startedAt) || startedAt > completedAt ||
      completedAt - startedAt > CRON_HEARTBEAT_LIMITS.maxRuntimeMs || !["ok", "auxiliary_degraded", "degraded", "failed"].includes(executionStatus)) return false;
  const finished = new Date(completedAt).toISOString();
  const result = await bounded(signal => admin.from("motorist_worker_status").upsert({
    instance_id: configuration.instanceId,
    deployment_version: configuration.release,
    heartbeat_at: finished,
    scheduler_tick_at: new Date(startedAt).toISOString(),
    scheduler_status: executionStatus,
    updated_at: finished,
  }, { onConflict: "instance_id" }).abortSignal(signal));
  if (result && !result.error) return true;
  try { console.warn(JSON.stringify({ scope: "telephony-cron-heartbeat", status: "unconfirmed" })); } catch { /* No observer failure can break the cron. */ }
  return false;
}

export type CronReadinessReason = "disabled" | "ok" | "auxiliary_degraded" | "configuration_invalid" | "writer_disabled"
  | "heartbeat_unavailable" | "heartbeat_missing" | "heartbeat_invalid" | "critical_jobs_failed" | "heartbeat_stale";
export type CronReadiness = { ready: boolean; reason: CronReadinessReason };

/** Safe reason codes are for internal observations, never raw database errors. */
export async function cronHeartbeatReadiness(admin: Admin, env: Environment = process.env): Promise<CronReadiness> {
  if (env.DIAGNOSTICS_CRON_READINESS_ENABLED !== "true") return { ready: true, reason: "disabled" };
  const configuration = cronHeartbeatConfiguration(env);
  if (!configuration) return { ready: false, reason: "configuration_invalid" };
  if (env.DIAGNOSTICS_CRON_HEARTBEAT_ENABLED !== "true") return { ready: false, reason: "writer_disabled" };
  const result = await bounded(signal => admin.from("motorist_worker_status")
    .select("instance_id,deployment_version,heartbeat_at,scheduler_tick_at,scheduler_status,updated_at")
    .eq("instance_id", configuration.instanceId).abortSignal(signal).maybeSingle());
  if (!result || result.error) return { ready: false, reason: "heartbeat_unavailable" };
  const row = result.data;
  if (!row) return { ready: false, reason: "heartbeat_missing" };
  if (row.instance_id !== configuration.instanceId || !validRelease(row.deployment_version) || !row.scheduler_tick_at)
    return { ready: false, reason: "heartbeat_invalid" };
  const startedAt = Date.parse(row.scheduler_tick_at);
  const completedAt = Date.parse(row.heartbeat_at);
  const updatedAt = Date.parse(row.updated_at);
  const now = Date.now();
  // A fresh previous release is valid during a rollout in the SAME project/DB.
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || !Number.isFinite(updatedAt) ||
      startedAt > completedAt || completedAt > now || updatedAt !== completedAt ||
      completedAt - startedAt > CRON_HEARTBEAT_LIMITS.maxRuntimeMs)
    return { ready: false, reason: "heartbeat_invalid" };
  if (now - completedAt > CRON_HEARTBEAT_LIMITS.maxAgeMs) return { ready: false, reason: "heartbeat_stale" };
  if (row.scheduler_status === "degraded" || row.scheduler_status === "failed") return { ready: false, reason: "critical_jobs_failed" };
  if (row.scheduler_status !== "ok" && row.scheduler_status !== "auxiliary_degraded") return { ready: false, reason: "heartbeat_invalid" };
  return { ready: true, reason: row.scheduler_status };
}

/** Default-off extension of the existing generic readiness response. */
export async function cronHeartbeatReady(admin: Admin, env: Environment = process.env): Promise<boolean> {
  return (await cronHeartbeatReadiness(admin, env)).ready;
}
