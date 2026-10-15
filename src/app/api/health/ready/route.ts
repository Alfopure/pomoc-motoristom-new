import { getSupabaseServiceEnv } from "@/lib/supabase/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAppVersion } from "@/server/app-version";
import { cronHeartbeatReadiness, type CronReadinessReason } from "@/server/diagnostics/cron-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DatabaseReason = "ok" | "database_unavailable" | "database_timeout";
async function databaseReadiness(admin: ReturnType<typeof createSupabaseAdminClient>): Promise<DatabaseReason> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The race also bounds a transport that ignores cancellation. No retries or
    // writes: readiness only needs one small read, with a shared 3 s deadline.
    return await Promise.race([
      Promise.resolve().then(async (): Promise<DatabaseReason> => {
        const result = await admin.from("motorist_organizations").select("id", { count: "exact", head: true }).abortSignal(controller.signal);
        return result.error ? "database_unavailable" : "ok";
      }).catch((): DatabaseReason => "database_unavailable"),
      new Promise<DatabaseReason>(resolve => { timer = setTimeout(() => { controller.abort(); resolve("database_timeout"); }, 3_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function GET() {
  const checkedAt = new Date().toISOString();
  const version = getAppVersion();
  let database: DatabaseReason | "not_checked" = "not_checked";
  let cron: CronReadinessReason | "not_checked" = "not_checked";
  let reason: "configuration_unavailable" | "dependency_unavailable" | "unexpected_failure" = "unexpected_failure";
  try {
    if (!getSupabaseServiceEnv()) {
      reason = "configuration_unavailable";
      throw new Error("Readiness configuration unavailable");
    }
    const admin = createSupabaseAdminClient();
    const [databaseResult, heartbeat] = await Promise.all([databaseReadiness(admin), cronHeartbeatReadiness(admin)]);
    database = databaseResult;
    cron = heartbeat.reason;
    if (database !== "ok" || !heartbeat.ready) {
      reason = "dependency_unavailable";
      throw new Error("Readiness dependency unavailable");
    }
    return Response.json({ status: "ready", version, checkedAt }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Allowlisted enums only: no SQL, tenant IDs, environment values or caught
    // exception messages reach logs or the unauthenticated public response.
    try { console.warn(JSON.stringify({ scope: "application-readiness", status: "not_ready", version, checkedAt, reason, database, cron })); } catch { /* Observability cannot change readiness. */ }
    return Response.json({ status: "not_ready", version, checkedAt }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
