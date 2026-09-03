import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { issueWebphoneToken } from "@/server/telephony/operator-devices";
import { createTelephonyDeps, TELEPHONY_ROUTE_ROLES, telephonyConfiguredOrResponse, telephonyErrorResponse } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Short-lived Telnyx WebRTC credential token for the browser phone.
 *
 * Minting rotates `device_session_id`, so the previously opened tab loses its
 * heartbeat (409) and disconnects — one active device per operator.
 */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const token = await issueWebphoneToken(
      { admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment },
      { organizationId: deps.organizationId, profileId: actor.profileId, userAgent: request.headers.get("user-agent") },
    );

    return Response.json(token, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Prihlasovací token pre telefón sa nepodarilo vydať.");
  }
}
