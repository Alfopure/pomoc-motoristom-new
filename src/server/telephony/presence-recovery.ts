import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { releaseOperatorPresence } from "./routing/reservation";

type RecoveryDeps = {
  admin: SupabaseClient<Database>;
  organizationId: string;
  now?: () => Date;
};

export type PresenceRecoveryResult = {
  scanned: number;
  released: number;
  skipped: number;
  errors: Array<{ profileId: string; sessionId: string; error: string }>;
};

/**
 * Repairs historical ownership only after the entire session is terminal and
 * every leg is closed. Runs in the existing cron; it never contacts a provider.
 * The release RPC checks the captured session, revision and token under locks,
 * retaining pause return and history in the same transaction.
 */
export async function sweepEndedSessionPresence(deps: RecoveryDeps, limit = 100): Promise<PresenceRecoveryResult> {
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await deps.admin.from("motorist_operator_presence").select("*")
    .eq("organization_id", deps.organizationId).in("status", ["ringing", "on_call"])
    .not("current_session_id", "is", null).order("status_since").limit(Math.max(1, Math.min(100, limit)));
  if (candidates.error) throw new Error(`stale presence lookup failed: ${candidates.error.message}`);
  const result: PresenceRecoveryResult = { scanned: candidates.data?.length ?? 0, released: 0, skipped: 0, errors: [] };
  for (const presence of candidates.data ?? []) {
    const sessionId = presence.current_session_id!;
    try {
      // A pre-contract schema lacks the CAS revision needed for safe repair.
      if (presence.presence_revision === undefined) { result.skipped++; continue; }
      const session = await deps.admin.from("motorist_call_sessions").select("id, state, ended_at")
        .eq("organization_id", deps.organizationId).eq("id", sessionId).in("state", ["ended", "failed"]).maybeSingle();
      if (session.error) throw new Error(`terminal session lookup failed: ${session.error.message}`);
      const endedAt = session.data?.ended_at ? Date.parse(session.data.ended_at) : NaN;
      if (!Number.isFinite(endedAt) || endedAt > now.getTime()) { result.skipped++; continue; }
      const open = await deps.admin.from("motorist_call_legs").select("id").eq("organization_id", deps.organizationId)
        .eq("session_id", sessionId).is("ended_at", null).limit(1);
      if (open.error) throw new Error(`terminal legs lookup failed: ${open.error.message}`);
      if (open.data?.length) { result.skipped++; continue; }

      let wrapUpUntil: string | null = null;
      if (presence.status === "on_call") {
        const settings = await deps.admin.from("motorist_operator_telephony_settings").select("wrap_up_seconds")
          .eq("organization_id", deps.organizationId).eq("profile_id", presence.profile_id).maybeSingle();
        if (settings.error) throw new Error(`wrap-up policy lookup failed: ${settings.error.message}`);
        const seconds = settings.data?.wrap_up_seconds ?? 30;
        // Recovery must not start a fresh wrap-up five minutes after a call.
        if (seconds > 0 && endedAt + seconds * 1000 > now.getTime()) wrapUpUntil = new Date(endedAt + seconds * 1000).toISOString();
      }
      const release = await releaseOperatorPresence(deps.admin, { organizationId: deps.organizationId,
        profileId: presence.profile_id, sessionId, expectedRevision: presence.presence_revision,
        expectedToken: presence.offer_token, status: wrapUpUntil ? "after_call_work" : "available", wrapUpUntil,
        source: "cron", reason: `ended session presence recovery:${sessionId}` });
      if (release.applied) result.released++;
      else result.skipped++;
    } catch (error) {
      result.errors.push({ profileId: presence.profile_id, sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
