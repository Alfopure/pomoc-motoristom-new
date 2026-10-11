import type { MobileConsole } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { mobileActiveCall } from "@/server/mobile/read-model";
import { loadActiveCallsCached } from "@/server/telephony/active-calls";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const scope = mobileScope(actor);
    // Read-only snapshot: no recovery, sweeper, heartbeat or provider operations.
    const snapshot = await loadActiveCallsCached({
      admin: createSupabaseAdminClient(), organizationId: actor.organizationId,
      // The TEST application's persisted telephony namespace is development.
      environment: scope.environment === "production" ? "production" : "development", configured: false,
    }, { profileId: actor.profileId, canManageAssignments: false });
    const calls = new Map([...snapshot.calls, ...snapshot.waiting].filter(call => call.mine).map(call => [call.sessionId, call]));
    const payload: MobileConsole = {
      ...scope, checkedAt: snapshot.checkedAt,
      presence: { status: snapshot.ownPresence?.status ?? "offline", since: snapshot.ownPresence?.statusSince ?? null },
      activeCalls: [...calls.values()].map(mobileActiveCall),
      capabilities: { voice: false, presenceWrite: false },
    };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Ústredňu sa nepodarilo načítať."); }
}
