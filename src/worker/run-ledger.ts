import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { JOB_NAMES, type JobName } from "@/server/jobs/types";

type JobRun = Database["public"]["Tables"]["motorist_job_runs"]["Row"];
type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export class RunLedger {
  readonly client: AdminClient;

  constructor() {
    this.client = createSupabaseAdminClient();
  }

  async enabledJobs() {
    const result = await this.client.from("motorist_job_controls").select("job_name").eq("enabled", true);
    throwOnError(result.error);
    return new Set((result.data ?? []).map((row) => row.job_name).filter(isJobNameValue));
  }

  async disableJob(jobName: JobName) {
    const result = await this.client
      .from("motorist_job_controls")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("job_name", jobName)
      .eq("enabled", true)
      .select("job_name");
    throwOnError(result.error);
    return (result.data ?? []).length > 0;
  }

  async enqueue(input: {
    runId: string;
    jobName: JobName;
    scheduledFor: string;
    payload: Json;
    payloadHash: string;
  }) {
    const result = await this.client.rpc("motorist_enqueue_job_run", {
      p_run_id: input.runId,
      p_job_name: input.jobName,
      p_scheduled_for: input.scheduledFor,
      p_payload: input.payload,
      p_payload_hash: input.payloadHash,
    });
    throwOnError(result.error);
    return result.data;
  }

  async claim(workerId: string) {
    const result = await this.client.rpc("motorist_claim_job_run", {
      p_worker_id: workerId,
      p_lease_seconds: 420,
    });
    throwOnError(result.error);
    return (result.data?.[0] ?? null) as JobRun | null;
  }

  async renew(runId: string, workerId: string, leaseSeconds: number) {
    const result = await this.client.rpc("motorist_renew_job_run_lease", {
      p_run_id: runId,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    throwOnError(result.error);
    return result.data === true;
  }

  async complete(runId: string, workerId: string, resultSafe: Json) {
    const result = await this.client.rpc("motorist_complete_job_run", {
      p_run_id: runId,
      p_worker_id: workerId,
      p_result_safe: resultSafe,
    });
    throwOnError(result.error);
    return result.data === true;
  }

  async fail(input: {
    runId: string;
    workerId: string;
    errorSafe: string;
    nextAttemptAt: string;
    terminal: boolean;
  }) {
    const result = await this.client.rpc("motorist_fail_job_run", {
      p_run_id: input.runId,
      p_worker_id: input.workerId,
      p_error_safe: input.errorSafe,
      p_next_attempt_at: input.nextAttemptAt,
      p_terminal: input.terminal,
    });
    throwOnError(result.error);
    return result.data === true;
  }

  async heartbeat(input: {
    workerId: string;
    deploymentVersion: string;
    schedulerStatus: string;
    schedulerTickAt: string | null;
    viptelWsStatus: string;
    lastViptelEventAt?: string | null;
  }) {
    const now = new Date().toISOString();
    const heartbeat = {
        instance_id: input.workerId,
        deployment_version: input.deploymentVersion,
        heartbeat_at: now,
        scheduler_tick_at: input.schedulerTickAt,
        scheduler_status: input.schedulerStatus,
        viptel_ws_status: input.viptelWsStatus,
        updated_at: now,
        ...(input.lastViptelEventAt !== undefined ? { last_viptel_event_at: input.lastViptelEventAt } : {}),
      };
    const result = await this.client.from("motorist_worker_status").upsert(
      heartbeat,
      { onConflict: "instance_id" },
    );
    throwOnError(result.error);
  }
}

function throwOnError(error: { message: string } | null) {
  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Uses the canonical JOB_NAMES rather than a second hand-maintained copy.
 *
 * This list used to be duplicated here, and a job added to the registry but not
 * to this copy was silently filtered out of `enabledJobs()` -- so the scheduler
 * never enqueued it, with no error anywhere, even though its control row said
 * enabled. Deriving it removes that failure mode entirely.
 */
function isJobNameValue(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}
