import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { issueWebphoneToken } from "@/server/telephony/operator-devices";
import { createTelephonyDeps, readJsonBody, TELEPHONY_ROUTE_ROLES, telephonyConfiguredOrResponse, telephonyErrorResponse } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Short-lived Telnyx WebRTC credential token for the browser phone.
 *
 * Minting rotates `device_session_id`, so the previously opened tab loses its
 * heartbeat (409) and disconnects — one active device per operator. When that
 * tab is live and its operator is ringing or on a call the request is refused
 * with 409 until the browser repeats it with `{ takeover: true }`. A tab that
 * renews its own token sends its `deviceSessionId` and is never refused — the
 * refresh must not tear down the socket carrying the call in progress.
 */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const body = await readJsonBody<{ takeover?: unknown; deviceSessionId?: unknown }>(request).catch(() => ({}) as { takeover?: unknown; deviceSessionId?: unknown });
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const token = await issueWebphoneToken(
      { admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment },
      {
        organizationId: deps.organizationId,
        profileId: actor.profileId,
        userAgent: request.headers.get("user-agent"),
        takeover: body?.takeover === true,
        // The tab's current session id: a renewal of its own credential is not a takeover.
        deviceSessionId: typeof body?.deviceSessionId === "string" ? body.deviceSessionId : null,
      },
    );

    return Response.json(token, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Prihlasovací token pre telefón sa nepodarilo vydať.");
  }
}
