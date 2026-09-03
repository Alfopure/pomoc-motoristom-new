import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

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
  const message = describeIncidentError(input.error, input.context);
  try {
    const existing = await admin.from("motorist_job_incidents").select("incident_id, consecutive_failures").eq("job_name", input.job).eq("status", "open").maybeSingle();
    if (existing.error) return { recorded: false, incidentId: null, consecutiveFailures: 0, error: existing.error.message };

    if (existing.data) {
      const failures = Number(existing.data.consecutive_failures ?? 0) + 1;
      const updated = await admin
        .from("motorist_job_incidents")
        .update({ consecutive_failures: failures, last_error_safe: message, updated_at: now })
        .eq("incident_id", existing.data.incident_id);
      if (updated.error) return { recorded: false, incidentId: existing.data.incident_id, consecutiveFailures: failures, error: updated.error.message };
      return { recorded: true, incidentId: existing.data.incident_id, consecutiveFailures: failures, error: null };
    }

    const inserted = await admin
      .from("motorist_job_incidents")
      .insert({ job_name: input.job, status: "open", consecutive_failures: 1, opened_at: now, last_error_safe: message, updated_at: now })
      .select("incident_id")
      .single();
    if (inserted.error) return { recorded: false, incidentId: null, consecutiveFailures: 1, error: inserted.error.message };
    return { recorded: true, incidentId: inserted.data.incident_id, consecutiveFailures: 1, error: null };
  } catch (error) {
    return { recorded: false, incidentId: null, consecutiveFailures: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Closes the open incident of a job (called after a clean run). */
export async function recoverTelephonyIncident(admin: AdminClient, job: TelephonyIncidentJob, now: Date = new Date()): Promise<boolean> {
  try {
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
