import { resolveAppEnvironment } from "@/lib/app-environment";
import { getAppVersion } from "@/server/app-version";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { BrowserCallObservation } from "@/lib/telephony/browser-call-telemetry";
import type { TelephonyEnvironment } from "./state/types";

/** Actor-owned observations only. ACK means emitted to the runtime log sink, not durable storage. */
export async function logBrowserCallObservations(
  deps: { admin: SupabaseClient<Database>; organizationId: string; environment: TelephonyEnvironment; logger?: (entry: Record<string, unknown>) => void },
  profileId: string,
  observations: BrowserCallObservation[],
): Promise<string[]> {
  const loggedIds: string[] = [];
  if (!observations.length || !deps.logger) return loggedIds;
  const signal = AbortSignal.timeout(1_500);
  try {
    const { data: legs, error: legError } = await deps.admin.from("motorist_call_legs")
      .select("id, session_id, telnyx_call_control_id")
      .eq("organization_id", deps.organizationId).eq("profile_id", profileId)
      .in("role", ["operator", "consult", "supervisor"])
      .in("telnyx_call_control_id", [...new Set(observations.map((row) => row.callControlId))]).abortSignal(signal);
    if (legError || !legs?.length) return loggedIds;
    const { data: sessions, error: sessionError } = await deps.admin.from("motorist_call_sessions")
      .select("id").eq("organization_id", deps.organizationId)
      .eq("metadata->>environment", deps.environment)
      .in("id", [...new Set(legs.map((leg) => leg.session_id))]).abortSignal(signal);
    if (sessionError || !sessions?.length) return loggedIds;
    const allowedSessions = new Set(sessions.map((session) => session.id));
    const allowedLegs = new Map(legs.filter((leg) => allowedSessions.has(leg.session_id)).map((leg) => [leg.telnyx_call_control_id, leg]));
    for (const row of observations) {
      const leg = allowedLegs.get(row.callControlId);
      if (!leg) continue;
      // ID supports offline deduplication across retries/beacons and instances.
      // Browser claims are observations, never authoritative call state or server-clock timestamps.
      await Promise.resolve(deps.logger({ scope: "browser_call_timing", source: "browser", observationId: row.id, pageId: row.pageId,
        sessionId: leg.session_id, legId: leg.id, environment: deps.environment, appEnvironment: resolveAppEnvironment(), serverBuild: getAppVersion(),
        phase: row.phase, browserMonotonicMs: row.atMs,
        ...(row.outcome ? { outcome: row.outcome } : {}),
        ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
        ...(row.answerMode ? { answerMode: row.answerMode } : {}) }));
      loggedIds.push(row.id);
    }
  } catch { /* Best-effort diagnostics must never affect registration or calls. */ }
  return loggedIds;
}
