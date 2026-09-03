import "server-only";

import type { Json } from "@/lib/supabase/database.types";
import { JOB_DEFINITIONS, jobDefinition } from "@/server/jobs/registry";
import { payloadHash, retryDelayMs, scheduledRunId, scheduledSlot } from "@/server/jobs/schedule";
import { isJobName, type JobContext, type JobName } from "@/server/jobs/types";
import { recordJobFailure, recordJobRecovery, safeJobResult } from "./alerts";
import { safeErrorMessage } from "./redaction";
import { RunLedger } from "./run-ledger";
import { SerializedOperation } from "./serialized-operation";

const SCHEDULER_TICK_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const CLAIM_IDLE_MS = 2_000;

export class ProductionWorker {
  private readonly ledger = new RunLedger();
  private readonly workerId = process.env.WORKER_INSTANCE_ID?.trim() || `worker-${process.pid}`;
  private readonly deploymentVersion = process.env.DEPLOYMENT_VERSION?.trim() || "development";
  private readonly schedulerEnabled = process.env.SCHEDULER_ENABLED?.trim().toLowerCase() === "true";
  private draining = false;
  private schedulerTickRunning = false;
  private lastSchedulerTickAt: string | null = null;
  private activeRunId: string | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatQueue = new SerializedOperation();

  async start() {
    this.installSignalHandlers();
    await this.heartbeat();

    this.schedulerTimer = setInterval(() => void this.schedulerTick(), SCHEDULER_TICK_MS);
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error) => log("heartbeat_failed", { error: safeErrorMessage(error) }));
    }, HEARTBEAT_MS);

    if (this.schedulerEnabled) {
      await this.schedulerTick();
    }

    log("worker_started", {
      workerId: this.workerId,
      deploymentVersion: this.deploymentVersion,
      schedulerEnabled: this.schedulerEnabled,
    });

    while (!this.draining) {
      if (!this.schedulerEnabled) {
        await sleep(CLAIM_IDLE_MS);
        continue;
      }

      try {
        const run = await this.ledger.claim(this.workerId);
        if (!run) {
          await sleep(CLAIM_IDLE_MS);
          continue;
        }
        await this.execute(run);
      } catch (error) {
        log("worker_loop_error", { error: safeErrorMessage(error) });
        await sleep(CLAIM_IDLE_MS);
      }
    }

    this.clearTimers();
    await this.heartbeat("disabled").catch((error) => {
      log("terminal_heartbeat_failed", { error: safeErrorMessage(error) });
    });
    log("worker_stopped", { workerId: this.workerId });
  }

  private async schedulerTick() {
    if (!this.schedulerEnabled || this.draining || this.schedulerTickRunning) return;
    this.schedulerTickRunning = true;

    try {
      const now = Date.now();
      const enabledJobs = await this.ledger.enabledJobs();
      for (const definition of Object.values(JOB_DEFINITIONS)) {
        if (!definition.schedule || !enabledJobs.has(definition.name)) continue;
        const slot = scheduledSlot(now, definition.schedule);
        const payload: Json = {};
        await this.ledger.enqueue({
          runId: scheduledRunId(definition.name, slot),
          jobName: definition.name,
          scheduledFor: slot.toISOString(),
          payload,
          payloadHash: payloadHash(payload),
        });
      }
      this.lastSchedulerTickAt = new Date().toISOString();
    } catch (error) {
      log("scheduler_tick_failed", { error: safeErrorMessage(error) });
    } finally {
      this.schedulerTickRunning = false;
    }
  }

  private async execute(run: {
    run_id: string;
    job_name: string;
    scheduled_for: string;
    payload: Json;
    attempt: number;
  }) {
    if (!isJobName(run.job_name)) {
      throw new Error(`Unknown job name: ${run.job_name}`);
    }

    const definition = jobDefinition(run.job_name);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Job exceeded ${definition.timeoutMs} ms timeout.`)),
      definition.timeoutMs,
    );
    const renewEveryMs = Math.min(30_000, Math.max(10_000, Math.floor((definition.leaseSeconds * 1000) / 3)));
    const leaseTimer = setInterval(() => {
      void this.renewLease(run.run_id, definition.leaseSeconds, controller);
    }, renewEveryMs);

    this.activeRunId = run.run_id;
    log("job_started", { runId: run.run_id, jobName: run.job_name, attempt: run.attempt });

    const context: JobContext = {
      runId: run.run_id,
      scheduledFor: run.scheduled_for,
      signal: controller.signal,
    };

    try {
      const result = await definition.run(context, payloadFor(run.job_name, run.payload) as never);
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Job aborted.");
      }
      const completed = await this.ledger.complete(
        run.run_id,
        this.workerId,
        safeJobResult(result.status, result.summarySafe),
      );
      if (!completed) {
        throw new Error("Job completion rejected because the lease is no longer owned.");
      }
      await recordJobRecovery(this.ledger, run.job_name);
      if (result.status === "success") {
        await pingJobDeadman(run.job_name).catch((error) => {
          log("job_healthcheck_error", { jobName: run.job_name, error: safeErrorMessage(error) });
        });
      }
      log("job_completed", { runId: run.run_id, jobName: run.job_name, status: result.status });
    } catch (error) {
      const message = safeErrorMessage(error);
      const terminal = run.attempt >= definition.maxAttempts;
      const nextAttemptAt = new Date(Date.now() + retryDelayMs(run.attempt)).toISOString();
      const failed = await this.ledger.fail({
        runId: run.run_id,
        workerId: this.workerId,
        errorSafe: message,
        nextAttemptAt,
        terminal,
      });
      if (failed) {
        await recordJobFailure(this.ledger, definition, message);
      }
      log("job_failed", {
        runId: run.run_id,
        jobName: run.job_name,
        attempt: run.attempt,
        terminal,
        leaseOwned: failed,
        error: message,
      });
    } finally {
      clearTimeout(timeout);
      clearInterval(leaseTimer);
      this.activeRunId = null;
    }
  }

  private async renewLease(runId: string, leaseSeconds: number, controller: AbortController) {
    try {
      const renewed = await this.ledger.renew(runId, this.workerId, leaseSeconds);
      if (!renewed) {
        controller.abort(new Error("Job lease was lost."));
      }
    } catch (error) {
      controller.abort(new Error(`Job lease renewal failed: ${safeErrorMessage(error)}`));
    }
  }

  private async heartbeat(stoppedStatus?: "disabled") {
    return this.heartbeatQueue.run(() => this.writeHeartbeat(stoppedStatus));
  }

  private async writeHeartbeat(stoppedStatus?: "disabled") {
    const schedulerStatus = stoppedStatus
      ?? (this.draining ? "draining" : this.schedulerEnabled ? "running" : "disabled");
    await this.ledger.heartbeat({
      workerId: this.workerId,
      deploymentVersion: this.deploymentVersion,
      schedulerStatus,
      schedulerTickAt: stoppedStatus ? null : this.lastSchedulerTickAt,
    });

    if (
      this.schedulerEnabled &&
      !this.draining &&
      this.lastSchedulerTickAt &&
      Date.now() - new Date(this.lastSchedulerTickAt).getTime() < 90_000
    ) {
      await pingDeadman();
    }
  }

  private installSignalHandlers() {
    const drain = (signal: string) => {
      if (this.draining) return;
      this.draining = true;
      log("worker_draining", { signal, activeRunId: this.activeRunId });
    };
    process.on("SIGTERM", () => drain("SIGTERM"));
    process.on("SIGINT", () => drain("SIGINT"));
  }

  private clearTimers() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }
}

function payloadFor(jobName: JobName, payload: Json) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid payload for ${jobName}.`);
  }
  return payload;
}

async function pingDeadman() {
  const url = process.env.HEALTHCHECKS_PING_URL?.trim();
  if (!url) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Deadman ping failed with HTTP ${response.status}.`);
  }
}

async function pingJobDeadman(jobName: JobName) {
  const encoded = process.env.HEALTHCHECKS_JOB_URLS_JSON?.trim();
  if (!encoded) return;
  let urls: unknown;
  try {
    urls = JSON.parse(encoded);
  } catch {
    throw new Error("HEALTHCHECKS_JOB_URLS_JSON is not valid JSON.");
  }
  if (!urls || typeof urls !== "object" || Array.isArray(urls)) {
    throw new Error("HEALTHCHECKS_JOB_URLS_JSON must be an object.");
  }
  const value = (urls as Record<string, unknown>)[jobName];
  if (typeof value !== "string" || !value.trim()) return;
  const response = await fetch(value.trim(), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Job healthcheck ping failed with HTTP ${response.status}.`);
}

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level: event.endsWith("failed") || event.endsWith("error") ? "error" : "info", event, ...fields }));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
