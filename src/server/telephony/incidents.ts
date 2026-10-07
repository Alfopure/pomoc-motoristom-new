import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { readPendingEffects } from "./state/continuation";

/**
 * Telephony incidents reuse `motorist_job_incidents` (one open row per
 * `job_name`, see `src/worker/alerts.ts`). Each telephony surface has its own
 * job name (inserted into `motorist_job_controls` by
 * `20260903120000_telephony_incident_jobs.sql`) so the health route and the
 * alert e-mail can distinguish webhook failures from command failures.
 *
 * Recording is best-effort: a failure here must never mask the original
 * error nor block a webhook response.
 */

export const TELEPHONY_INCIDENT_JOBS = {
  webhook: "telephony.telnyx.webhook",
  commands: "telephony.telnyx.commands",
  actions: "telephony.telnyx.actions",
  capacity: "telephony.routing.capacity",
} as const;

export type TelephonyIncidentJob = (typeof TELEPHONY_INCIDENT_JOBS)[keyof typeof TELEPHONY_INCIDENT_JOBS];

type AdminClient = SupabaseClient<Database>;

export type TelephonyIncidentInput = {
  job: TelephonyIncidentJob;
  error: unknown;
  context?: Record<string, unknown>;
  now?: Date;
};

export function describeIncidentError(error: unknown, context?: Record<string, unknown>): string {
  const base = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const suffix = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : "";
  return `${base}${suffix}`.slice(0, 2000);
}

export type TelephonyIncidentResult = { recorded: boolean; incidentId: string | null; consecutiveFailures: number; error: string | null };

export async function recordTelephonyIncident(admin: AdminClient, input: TelephonyIncidentInput): Promise<TelephonyIncidentResult> {
  const now = (input.now ?? new Date()).toISOString();
  // A new failure invalidates the "this job is clean" memo, so the next clean
  // run closes the incident immediately instead of waiting out the throttle.
  lastRecoveryCheck.delete(input.job);
  const message = describeIncidentError(input.error, input.context);
  try {
    // Another instance can recover this row or report a failure between the
    // read and write. Retry that race without writing into a recovered row.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await admin.from("motorist_job_incidents").select("incident_id, consecutive_failures, updated_at").eq("job_name", input.job).eq("status", "open").maybeSingle();
      if (existing.error) return { recorded: false, incidentId: null, consecutiveFailures: 0, error: existing.error.message };

      if (existing.data) {
        const failures = Number(existing.data.consecutive_failures ?? 0) + 1;
        const updated = await admin
          .from("motorist_job_incidents")
          .update({ consecutive_failures: failures, last_error_safe: message, updated_at: now })
          .eq("incident_id", existing.data.incident_id)
          .eq("status", "open")
          .eq("updated_at", existing.data.updated_at)
          .eq("consecutive_failures", existing.data.consecutive_failures)
          .select("incident_id");
        if (updated.error) return { recorded: false, incidentId: existing.data.incident_id, consecutiveFailures: failures, error: updated.error.message };
        if (!updated.data?.length) continue;
        return { recorded: true, incidentId: existing.data.incident_id, consecutiveFailures: failures, error: null };
      }

      const inserted = await admin
        .from("motorist_job_incidents")
        .insert({ job_name: input.job, status: "open", consecutive_failures: 1, opened_at: now, last_error_safe: message, updated_at: now })
        .select("incident_id")
        .single();
      if (inserted.error?.code === "23505") continue;
      if (inserted.error) return { recorded: false, incidentId: null, consecutiveFailures: 1, error: inserted.error.message };
      return { recorded: true, incidentId: inserted.data.incident_id, consecutiveFailures: 1, error: null };
    }
    return { recorded: false, incidentId: null, consecutiveFailures: 0, error: "Incident changed concurrently; recovery was not confirmed" };
  } catch (error) {
    return { recorded: false, incidentId: null, consecutiveFailures: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Closes the open incident of a job (called after a clean run). */
export async function recoverTelephonyIncident(admin: AdminClient, job: TelephonyIncidentJob, now: Date = new Date()): Promise<boolean> {
  try {
    if (job === TELEPHONY_INCIDENT_JOBS.commands) {
      const existing = await admin.from("motorist_job_incidents")
        .select("incident_id, updated_at, consecutive_failures")
        .eq("job_name", job).eq("status", "open").maybeSingle();
      if (existing.error || !existing.data) return false;
      // Uses the pending-effects partial index, and only while an incident is
      // open. A successful command in a different call is not recovery proof.
      const pending = await admin.from("motorist_call_sessions")
        .select("pending_effects").not("pending_effects", "is", null)
        .not("termination_requested_at", "is", null).limit(101);
      if (pending.error || !pending.data || pending.data.length > 100) return false;
      for (const session of pending.data) {
        const raw = session.pending_effects;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
        for (const entry of readPendingEffects(session).entries) {
          if (!entry?.event || !["app", "telnyx"].includes(entry.event.kind) || typeof entry.event.type !== "string" ||
            !Array.isArray(entry.commands) || !Array.isArray(entry.completedCommands) ||
            !entry.completedCommands.every(key => typeof key === "string") ||
            entry.commands.some(command => !command || typeof command.kind !== "string" ||
              command.kind !== "ring_fanout" && typeof command.commandId !== "string")) return false;
          if (entry.event.kind === "app" && entry.event.type === "hangup" && entry.commands.some(command =>
            command.kind === "hangup" && !entry.completedCommands.includes(command.commandId))) return false;
        }
      }
      const recovered = await admin.from("motorist_job_incidents")
        .update({ status: "recovered", recovered_at: now.toISOString(), updated_at: now.toISOString() })
        .eq("incident_id", existing.data.incident_id).eq("status", "open")
        .eq("updated_at", existing.data.updated_at)
        .eq("consecutive_failures", existing.data.consecutive_failures).select("incident_id");
      return !recovered.error && Boolean(recovered.data?.length);
    }
    const { data, error } = await admin
      .from("motorist_job_incidents")
      .update({ status: "recovered", recovered_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("job_name", job)
      .eq("status", "open")
      .select("incident_id");
    if (error) return false;
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/**
 * How often one serverless instance may look for an open incident to close.
 * The clean paths (every processed webhook, every applied transition, every
 * call action) run far too often for an unconditional UPDATE.
 */
export const INCIDENT_RECOVERY_INTERVAL_MS = 60_000;

const lastRecoveryCheck = new Map<TelephonyIncidentJob, number>();

/** Test seam: clears the per-instance recovery throttle. */
export function resetIncidentRecoveryThrottle(): void {
  lastRecoveryCheck.clear();
}

/**
 * Closes the open incident of a job after a clean run, at most once per
 * `INCIDENT_RECOVERY_INTERVAL_MS` per instance. Without this an incident opened
 * by a single transient failure would stay `open` forever and every health
 * surface would report telephony as permanently down.
 */
export async function recoverTelephonyIncidentThrottled(admin: AdminClient, job: TelephonyIncidentJob, now: Date = new Date()): Promise<boolean> {
  const at = now.getTime();
  const last = lastRecoveryCheck.get(job);
  if (last !== undefined && at - last < INCIDENT_RECOVERY_INTERVAL_MS && at >= last) return false;
  lastRecoveryCheck.set(job, at);
  return recoverTelephonyIncident(admin, job, now);
}
