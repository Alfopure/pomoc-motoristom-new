import type { Json } from "@/lib/supabase/database.types";
import type { JobName, JobPayloadMap } from "@/server/jobs/types";

export const ONE_SHOT_TARGET_REF = "sjcsrygkkmersoczpunh";

export const ONE_SHOT_JOB_NAMES = [
  "fleet.webdispecink.positions",
  "fleet.webdispecink.catalog",
  "fleet.commander.positions",
  "fleet.commander.catalog",
  "notifications.materialize",
  "telephony.recordings.sync",
  "telephony.transcripts.process",
  "telephony.viptel.reconcile",
  "infra.hetzner.audit",
] as const satisfies readonly JobName[];

export type OneShotJobName = (typeof ONE_SHOT_JOB_NAMES)[number];

type OneShotPayloads = { [K in OneShotJobName]: Readonly<JobPayloadMap[K]> };

const FIXED_PAYLOADS: OneShotPayloads = {
  "fleet.webdispecink.positions": {},
  "fleet.webdispecink.catalog": {},
  "fleet.commander.positions": {},
  "fleet.commander.catalog": {},
  "notifications.materialize": { limit: 1 },
  "telephony.recordings.sync": { maxDownloads: 1 },
  "telephony.transcripts.process": { maxItems: 1 },
  "telephony.viptel.reconcile": {},
  "infra.hetzner.audit": {},
};

const NUMERIC_SUMMARY_FIELDS: Record<OneShotJobName, readonly string[]> = {
  "fleet.webdispecink.positions": ["positionCount", "updatedAssetPositions", "unmappedPositionCount"],
  "fleet.webdispecink.catalog": ["catalogCount", "providerVehicleCount", "linkedVehicleCount"],
  "fleet.commander.positions": ["fetchedCount", "updatedCount", "skippedCount", "errorCount"],
  "fleet.commander.catalog": ["fetchedCount", "createdCount", "updatedCount", "errorCount"],
  "notifications.materialize": ["processed", "sent", "cancelled", "failed"],
  "telephony.recordings.sync": ["cdrWithRecording", "discovered", "processed", "failed", "pendingLeft"],
  "telephony.transcripts.process": ["candidates", "processed", "failed", "skipped", "aiProcessed", "aiFailed"],
  "telephony.viptel.reconcile": ["activeFetched", "activeUpserts", "cdrFetched", "cdrUpserts", "terminalRepairs"],
  "infra.hetzner.audit": ["servers", "primaryIps", "volumes", "floatingIps", "loadBalancers", "backups"],
};

const STATUS_SUMMARY_FIELDS: Partial<Record<OneShotJobName, Readonly<Record<string, readonly string[]>>>> = {
  "fleet.webdispecink.positions": { mode: ["positions"] },
  "fleet.webdispecink.catalog": { mode: ["catalog"] },
  "fleet.commander.positions": { status: ["success"] },
  "fleet.commander.catalog": { status: ["success"] },
  "telephony.recordings.sync": { status: ["ok"] },
  "telephony.transcripts.process": { status: ["ok"] },
};

export type OneShotRequest = {
  job: OneShotJobName;
  payload: OneShotPayloads[OneShotJobName];
};

export type OneShotOutput = {
  schema: "motorist-one-shot/v1";
  ok: boolean;
  job: OneShotJobName | "invalid";
  status: "success" | "skipped" | "failed";
  summary: Record<string, number | string>;
};

export function parseOneShotRequest(argv: readonly string[], env: NodeJS.ProcessEnv): OneShotRequest {
  const parsed = parseArguments(argv);
  assertProductionRuntime(env, parsed.expectedProjectRef);

  if (!parsed.acknowledgeTargetWrites) throw new Error("target write acknowledgement is required");
  if (parsed.job === "notifications.materialize" && !parsed.acknowledgeExternalDelivery) {
    throw new Error("external delivery acknowledgement is required");
  }
  if (parsed.job !== "notifications.materialize" && parsed.acknowledgeExternalDelivery) {
    throw new Error("external delivery acknowledgement is not applicable");
  }
  if (parsed.job === "telephony.transcripts.process" && !parsed.acknowledgePaidAi) {
    throw new Error("paid AI acknowledgement is required");
  }
  if (parsed.job !== "telephony.transcripts.process" && parsed.acknowledgePaidAi) {
    throw new Error("paid AI acknowledgement is not applicable");
  }

  return {
    job: parsed.job,
    payload: FIXED_PAYLOADS[parsed.job],
  };
}

export function safeJobFromArguments(argv: readonly string[]): OneShotJobName | "invalid" {
  const jobIndex = argv.indexOf("--job");
  const value = jobIndex >= 0 ? argv[jobIndex + 1] : undefined;
  return value && isOneShotJobName(value) ? value : "invalid";
}

export function projectOneShotSummary(
  job: OneShotJobName,
  summary: Json,
): Record<string, number | string> {
  if (!isPlainObject(summary)) throw new Error("job summary is not an object");

  const projected: Record<string, number | string> = {};
  for (const field of NUMERIC_SUMMARY_FIELDS[job]) {
    const value = summary[field];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error("job summary aggregate is invalid");
    }
    projected[field] = value as number;
  }

  for (const [field, allowedValues] of Object.entries(STATUS_SUMMARY_FIELDS[job] ?? {})) {
    const value = summary[field];
    if (typeof value !== "string" || !allowedValues.includes(value)) {
      throw new Error("job summary status is invalid");
    }
    projected[field] = value;
  }

  return projected;
}

export function oneShotOutput(
  job: OneShotJobName,
  status: "success" | "skipped",
  summary: Json,
): OneShotOutput {
  return {
    schema: "motorist-one-shot/v1",
    ok: status === "success",
    job,
    status,
    summary: status === "success" ? projectOneShotSummary(job, summary) : {},
  };
}

export function failedOneShotOutput(job: OneShotJobName | "invalid"): OneShotOutput {
  return {
    schema: "motorist-one-shot/v1",
    ok: false,
    job,
    status: "failed",
    summary: {},
  };
}

export function serializeOneShotOutput(output: OneShotOutput) {
  return `${JSON.stringify(output)}\n`;
}

function parseArguments(argv: readonly string[]) {
  let job: OneShotJobName | undefined;
  let expectedProjectRef: string | undefined;
  let acknowledgeTargetWrites = false;
  let acknowledgeExternalDelivery = false;
  let acknowledgePaidAi = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--job") {
      if (job || index + 1 >= argv.length) throw new Error("job argument is invalid");
      const value = argv[index + 1];
      if (!isOneShotJobName(value)) throw new Error("job is not allowed");
      job = value;
      index += 1;
      continue;
    }
    if (argument === "--expected-project-ref") {
      if (expectedProjectRef || index + 1 >= argv.length) throw new Error("project argument is invalid");
      expectedProjectRef = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--acknowledge-target-writes") {
      if (acknowledgeTargetWrites) throw new Error("duplicate acknowledgement");
      acknowledgeTargetWrites = true;
      continue;
    }
    if (argument === "--acknowledge-external-delivery") {
      if (acknowledgeExternalDelivery) throw new Error("duplicate acknowledgement");
      acknowledgeExternalDelivery = true;
      continue;
    }
    if (argument === "--acknowledge-paid-ai") {
      if (acknowledgePaidAi) throw new Error("duplicate acknowledgement");
      acknowledgePaidAi = true;
      continue;
    }
    throw new Error("unknown one-shot argument");
  }

  if (!job || !expectedProjectRef) throw new Error("required one-shot argument is missing");
  return {
    job,
    expectedProjectRef,
    acknowledgeTargetWrites,
    acknowledgeExternalDelivery,
    acknowledgePaidAi,
  };
}

function assertProductionRuntime(env: NodeJS.ProcessEnv, expectedProjectRef: string) {
  const targetUrl = `https://${ONE_SHOT_TARGET_REF}.supabase.co`;
  if (expectedProjectRef !== ONE_SHOT_TARGET_REF) throw new Error("expected project is not production target");
  if (env.NODE_ENV !== "production") throw new Error("runtime is not production");
  if (env.MOTORIST_DEV_AUTH_BYPASS !== "false") throw new Error("development auth bypass is not disabled");
  if (!/^hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(env.DEPLOYMENT_VERSION ?? "")) {
    throw new Error("deployment version is invalid");
  }
  if (env.SCHEDULER_ENABLED !== "false") throw new Error("scheduler is not exactly disabled");
  if (env.SUPABASE_PROJECT_REF !== ONE_SHOT_TARGET_REF) throw new Error("runtime project differs");
  if (env.SUPABASE_URL !== targetUrl) throw new Error("server database URL differs");
  if (env.NEXT_PUBLIC_SUPABASE_URL !== targetUrl) throw new Error("public database URL differs");
  if (!env.SUPABASE_SECRET_KEY || env.SUPABASE_SECRET_KEY !== env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("server database key aliases differ");
  }
  if (!env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY === env.SUPABASE_SECRET_KEY) {
    throw new Error("public and server database keys are invalid");
  }
}

function isOneShotJobName(value: string): value is OneShotJobName {
  return (ONE_SHOT_JOB_NAMES as readonly string[]).includes(value);
}

function isPlainObject(value: Json): value is Record<string, Json | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
