import { getSupabaseServiceEnv } from "@/lib/supabase/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAppVersion } from "@/server/app-version";
import { cronHeartbeatReady } from "@/server/diagnostics/cron-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checkedAt = new Date().toISOString();
  const version = getAppVersion();

  try {
    if (!getSupabaseServiceEnv()) {
      throw new Error("Supabase service environment is missing.");
    }

    const admin = createSupabaseAdminClient();
    const [result, cronReady] = await Promise.all([
      admin.from("motorist_organizations")
        .select("id", { count: "exact", head: true })
        .abortSignal(AbortSignal.timeout(3_000)),
      cronHeartbeatReady(admin),
    ]);

    if (result.error || !cronReady) {
      throw new Error("Supabase readiness query failed.");
    }

    return Response.json(
      { status: "ready", version, checkedAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "not_ready", version, checkedAt },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
