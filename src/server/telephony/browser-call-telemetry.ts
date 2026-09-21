import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { BrowserCallObservation } from "@/lib/telephony/browser-call-telemetry";
import type { TelephonyEnvironment } from "./state/types";

/** Called after an authenticated, current-device heartbeat; no voice work or DB writes. */
export async function logBrowserCallObservations(
  deps: { admin: SupabaseClient<Database>; organizationId: string; environment: TelephonyEnvironment; logger?: (entry: Record<string, unknown>) => void },
  profileId: string,
  observations: BrowserCallObservation[],
): Promise<void> {
  if (!observations.length || !deps.logger) return;
  try {
    const { data: legs, error: legError } = await deps.admin.from("motorist_call_legs")
      .select("id, session_id, telnyx_call_control_id")
      .eq("organization_id", deps.organizationId).eq("profile_id", profileId)
      .in("role", ["operator", "consult", "supervisor"])
      .in("telnyx_call_control_id", [...new Set(observations.map((row) => row.callControlId))]);
    if (legError || !legs?.length) return;
    const { data: sessions, error: sessionError } = await deps.admin.from("motorist_call_sessions")
      .select("id").eq("organization_id", deps.organizationId)
      .eq("metadata->>environment", deps.environment)
      .in("id", [...new Set(legs.map((leg) => leg.session_id))]);
    if (sessionError || !sessions?.length) return;
    const allowedSessions = new Set(sessions.map((session) => session.id));
    const allowedLegs = new Map(legs.filter((leg) => allowedSessions.has(leg.session_id)).map((leg) => [leg.telnyx_call_control_id, leg]));
    for (const row of observations) {
      const leg = allowedLegs.get(row.callControlId);
      if (!leg) continue;
      // ID supports offline deduplication across retries/beacons and instances.
      // Browser claims are observations, never authoritative call state or server-clock timestamps.
      await Promise.resolve(deps.logger({ scope: "browser_call_timing", source: "browser", observationId: row.id, pageId: row.pageId,
        sessionId: leg.session_id, legId: leg.id, environment: deps.environment,
        phase: row.phase, browserMonotonicMs: row.atMs,
        ...(row.outcome ? { outcome: row.outcome } : {}),
        ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
        ...(row.answerMode ? { answerMode: row.answerMode } : {}) }));
    }
  } catch { /* Best-effort diagnostics must never affect registration or calls. */ }
}
