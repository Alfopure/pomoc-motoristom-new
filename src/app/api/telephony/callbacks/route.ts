import { requireDefaultMotoristActor } from "@/server/api-auth";
import { callbackQueueDeps } from "@/server/telephony/callback-route";
import { loadCallbackQueue } from "@/server/telephony/callbacks";
import { createTelephonyDeps, TELEPHONY_ROUTE_ROLES, telephonyErrorResponse } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The callback queue (design §4 Phase 4). Member-level read: every dispatcher
 * sees who is waiting for a call back and how long they have waited.
 *
 * Unlike the call-control routes this one deliberately answers even when
 * telephony is not configured: the rows are ordinary database records and a
 * dispatcher must still be able to see (and cancel) them with the provider off.
 */
export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const queue = await loadCallbackQueue(
      callbackQueueDeps(deps),
      { profileId: actor.profileId, role: actor.role },
      { configured: deps.config.configured },
    );
    return Response.json(queue, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Frontu spätných volaní sa nepodarilo načítať.");
  }
}
