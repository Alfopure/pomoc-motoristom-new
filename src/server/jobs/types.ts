import type { Json } from "@/lib/supabase/database.types";

export const JOB_NAMES = [
  "fleet.webdispecink.positions",
  "fleet.webdispecink.catalog",
  "fleet.commander.positions",
  "fleet.commander.catalog",
  "fleet.swhouse.occupancy",
  "fleet.swhouse.roster",
  "notifications.materialize",
  "telephony.transcripts.process",
  "infra.hetzner.audit",
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export type JobPayloadMap = {
  "fleet.webdispecink.positions": Record<string, never>;
  "fleet.webdispecink.catalog": Record<string, never>;
  "fleet.commander.positions": Record<string, never>;
  "fleet.commander.catalog": Record<string, never>;
  "fleet.swhouse.occupancy": Record<string, never>;
  "fleet.swhouse.roster": Record<string, never>;
  "notifications.materialize": { limit?: number };
  "telephony.transcripts.process": { maxItems?: number };
  "infra.hetzner.audit": Record<string, never>;
};

export type JobSchedule = {
  everyMs: number;
  offsetMs: number;
};

export type JobContext = {
  runId: string;
  scheduledFor: string;
  signal: AbortSignal;
};

export type JobExecutionResult = {
  status: "success" | "skipped";
  summarySafe: Json;
};

export type JobDefinition<K extends JobName = JobName> = {
  name: K;
  schedule: JobSchedule | null;
  timeoutMs: number;
  leaseSeconds: number;
  maxAttempts: number;
  failureThreshold: number;
  freshnessMs: number;
  run(context: JobContext, payload: JobPayloadMap[K]): Promise<JobExecutionResult>;
};

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}
