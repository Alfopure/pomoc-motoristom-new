import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { latencyFlagsOf, webCallTuning } from "@/server/telephony/latency-flags";
import { issueWebphoneToken, refuseIfAccessLost } from "@/server/telephony/operator-devices";
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

    const body = await readJsonBody<{ takeover?: unknown; handoff?: unknown; deviceKind?: unknown; deviceSessionId?: unknown }>(request).catch(() => ({}) as { takeover?: unknown; handoff?: unknown; deviceKind?: unknown; deviceSessionId?: unknown });
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const device = { admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment, deviceKind: body.deviceKind === "mobile" ? "mobile" as const : "web" as const };
    const token = await issueWebphoneToken(
      device,
      {
        organizationId: deps.organizationId,
        profileId: actor.profileId,
        userAgent: request.headers.get("user-agent"),
        takeover: body?.takeover === true,
        handoff: body?.handoff === true,
        // The tab's current session id: a renewal of its own credential is not a takeover.
        deviceSessionId: typeof body?.deviceSessionId === "string" ? body.deviceSessionId : null,
      },
    );
    // A deactivation or removal that landed during the mint revokes this enrollment instead.
    await refuseIfAccessLost(device, { organizationId: deps.organizationId, profileId: actor.profileId }, token);

    // Connect-time switches (call-speed S5): the browser creates every new SDK
    // client right after a mint, so its first socket already follows them.
    const { webRtcRegion, webPrefetchIce } = webCallTuning(latencyFlagsOf(deps));
    return Response.json({ ...token, webRtcRegion, webPrefetchIce }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Prihlasovací token pre telefón sa nepodarilo vydať.");
  }
}
