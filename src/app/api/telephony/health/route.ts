import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { TelephonyHealthSignal } from "@/lib/telephony/health";
import { MutationError } from "@/server/motorist-mutations";
import { requireTelephonyActor } from "@/server/telephony-access";

export const runtime = "nodejs";

type WorkerRow = Pick<
  Database["public"]["Tables"]["motorist_worker_status"]["Row"],
  "heartbeat_at" | "instance_id" | "last_viptel_event_at" | "viptel_ws_status"
>;
type JobRunRow = Pick<
  Database["public"]["Tables"]["motorist_job_runs"]["Row"],
  "finished_at" | "scheduled_for" | "status" | "updated_at"
>;

const RECONCILE_JOB = "telephony.viptel.reconcile";
const WORKER_STALE_MS = 90_000;
const RECONCILE_STALE_MS = 5 * 60_000;

export async function GET() {
  const checkedAt = new Date().toISOString();

  try {
    await requireTelephonyActor();
    const supabase = createSupabaseAdminClient();
    const [workerResult, controlResult, latestRunResult, lastSuccessResult] = await Promise.all([
      supabase
        .from("motorist_worker_status")
        .select("heartbeat_at, instance_id, last_viptel_event_at, viptel_ws_status")
        .order("heartbeat_at", { ascending: false })
        .limit(20),
      supabase.from("motorist_job_controls").select("enabled").eq("job_name", RECONCILE_JOB).maybeSingle(),
      supabase
        .from("motorist_job_runs")
        .select("finished_at, scheduled_for, status, updated_at")
        .eq("job_name", RECONCILE_JOB)
        .order("scheduled_for", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("motorist_job_runs")
        .select("finished_at, scheduled_for, status, updated_at")
        .eq("job_name", RECONCILE_JOB)
        .eq("status", "succeeded")
        .order("scheduled_for", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const queryError = workerResult.error ?? controlResult.error ?? latestRunResult.error ?? lastSuccessResult.error;
    if (queryError) {
      throw new Error(queryError.message);
    }

    const worker = selectListenerWorker((workerResult.data ?? []) as WorkerRow[]);
    const latestRun = latestRunResult.data as JobRunRow | null;
    const lastSuccess = lastSuccessResult.data as JobRunRow | null;
    const lastReconcileAt = runTimestamp(lastSuccess);

    return Response.json({
      ok: true,
      checkedAt,
      websocket: classifyWebsocket(worker, checkedAt),
      reconciliation: classifyReconciliation({
        checkedAt,
        enabled: controlResult.data?.enabled === true,
        latestRun,
        lastSuccessAt: lastReconcileAt,
      }),
      lastEventAt: worker?.last_viptel_event_at ?? undefined,
      lastReconcileAt,
    });
  } catch (error) {
    const status = error instanceof MutationError ? error.status : 500;
    return Response.json(
      {
        ok: false,
        checkedAt,
        error: error instanceof Error ? error.message : "Stav telefónnej infraštruktúry sa nepodarilo načítať.",
      },
      { status },
    );
  }
}

function selectListenerWorker(workers: WorkerRow[]) {
  return (
    workers.find(
      (worker) =>
        worker.viptel_ws_status !== "disabled" ||
        Boolean(worker.last_viptel_event_at) ||
        /viptel|listener/i.test(worker.instance_id),
    ) ?? null
  );
}

function classifyWebsocket(worker: WorkerRow | null, checkedAt: string): TelephonyHealthSignal {
  if (!worker) {
    return { state: "disabled", detail: "Listener neposlal žiadny heartbeat.", checkedAt };
  }

  const heartbeatAge = ageMs(worker.heartbeat_at, checkedAt);
  if (heartbeatAge === undefined || heartbeatAge > WORKER_STALE_MS) {
    return {
      state: "stale",
      detail: `Listener heartbeat je starý (${formatTimestamp(worker.heartbeat_at)}).`,
      checkedAt,
      lastSuccessAt: worker.heartbeat_at,
    };
  }

  if (worker.viptel_ws_status === "connected") {
    return {
      state: "live",
      detail: "VIPTel WebSocket listener je pripojený.",
      checkedAt,
      lastSuccessAt: worker.last_viptel_event_at ?? worker.heartbeat_at,
    };
  }

  if (worker.viptel_ws_status === "disabled") {
    return { state: "disabled", detail: "VIPTel WebSocket listener je vypnutý.", checkedAt, lastSuccessAt: worker.heartbeat_at };
  }

  return {
    state: "degraded",
    detail: `Listener je v stave ${worker.viptel_ws_status || "neznámy"}.`,
    checkedAt,
    lastSuccessAt: worker.heartbeat_at,
  };
}

function classifyReconciliation(input: {
  checkedAt: string;
  enabled: boolean;
  latestRun: JobRunRow | null;
  lastSuccessAt?: string;
}): TelephonyHealthSignal {
  if (!input.enabled) {
    return { state: "disabled", detail: "CDR reconciliation job je vypnutý.", checkedAt: input.checkedAt, lastSuccessAt: input.lastSuccessAt };
  }

  if (!input.latestRun) {
    return { state: "configured", detail: "CDR reconciliation je zapnutý, ale ešte nemá beh.", checkedAt: input.checkedAt };
  }

  if (input.latestRun.status === "failed" || input.latestRun.status === "dead") {
    return {
      state: "degraded",
      detail: `Posledný CDR reconcile skončil ako ${input.latestRun.status}.`,
      checkedAt: input.checkedAt,
      lastSuccessAt: input.lastSuccessAt,
    };
  }

  const successAge = ageMs(input.lastSuccessAt, input.checkedAt);
  if (successAge === undefined || successAge > RECONCILE_STALE_MS) {
    return {
      state: "stale",
      detail: input.lastSuccessAt ? "Posledný úspešný CDR reconcile je starší ako 5 minút." : "CDR reconcile zatiaľ nemá úspešný beh.",
      checkedAt: input.checkedAt,
      lastSuccessAt: input.lastSuccessAt,
    };
  }

  return {
    state: "live",
    detail: "CDR reconciliation beží a posledný výsledok je čerstvý.",
    checkedAt: input.checkedAt,
    lastSuccessAt: input.lastSuccessAt,
  };
}

function runTimestamp(run: JobRunRow | null) {
  return run?.finished_at ?? run?.updated_at ?? run?.scheduled_for ?? undefined;
}

function ageMs(value: string | undefined, now: string) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  const current = Date.parse(now);
  return Number.isFinite(timestamp) && Number.isFinite(current) ? Math.max(0, current - timestamp) : undefined;
}

function formatTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString("sk-SK") : value;
}
