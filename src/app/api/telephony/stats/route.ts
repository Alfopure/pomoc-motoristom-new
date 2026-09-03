import { requireDefaultMotoristActor } from "@/server/api-auth";
import { createTelephonyDeps, telephonyErrorResponse } from "@/server/telephony/runtime";
import { loadTelephonyStatsCached } from "@/server/telephony/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wallboard and report widgets: senior dispatchers and above (design §4 Phase 4). */
export const STATS_ROLES = ["senior_dispatcher", "manager", "admin"] as const;

/**
 * One payload for the full-screen wallboard and the widgets in the reports
 * view.
 *
 * The answer is served from a five-second per-organisation cache
 * (`loadTelephonyStatsCached`): a wall display polls to stay alive, and every
 * duration on screen is re-derived in the browser from the timestamps in the
 * payload, so a handful of screens cost one database pass, not one each.
 *
 * Like the callback queue it answers with the provider switched off — the rows
 * are ordinary database records, and a manager reading yesterday's answer rate
 * has nothing to do with whether calls can be placed right now.
 */
export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor([...STATS_ROLES]);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const payload = await loadTelephonyStatsCached(
      { admin: deps.admin, organizationId: deps.organizationId, now: deps.now, logger: deps.logger },
      { configured: deps.config.configured },
    );
    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Štatistiky sa nepodarilo načítať.");
  }
}
