import { getSupabaseServiceEnv } from "@/lib/supabase/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checkedAt = new Date().toISOString();
  const version = process.env.DEPLOYMENT_VERSION?.trim() || "development";

  try {
    if (!getSupabaseServiceEnv()) {
      throw new Error("Supabase service environment is missing.");
    }

    const result = await createSupabaseAdminClient()
      .from("motorist_organizations")
      .select("id", { count: "exact", head: true })
      .abortSignal(AbortSignal.timeout(3_000));

    if (result.error) {
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
