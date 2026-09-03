import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { endWrapUp } from "@/server/telephony/presence-service";
import { createTelephonyDeps, TELEPHONY_ROUTE_ROLES, telephonyConfiguredOrResponse, telephonyErrorResponse } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Ukončiť wrap-up": ends after-call work early and returns to `available`. */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const row = await endWrapUp({ admin: deps.admin }, { organizationId: deps.organizationId, profileId: actor.profileId, source: "dispatch_console" });

    return Response.json({ ok: true, status: row.status, wrapUpUntil: row.wrap_up_until });
  } catch (error) {
    return telephonyErrorResponse(error, "Wrap-up sa nepodarilo ukončiť.");
  }
}
