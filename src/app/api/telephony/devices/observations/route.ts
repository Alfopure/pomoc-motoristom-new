import { readBrowserCallObservations } from "@/lib/telephony/browser-call-telemetry";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { logBrowserCallObservations } from "@/server/telephony/browser-call-telemetry";
import { createTelephonyDeps, readJsonBody, TELEPHONY_ROUTE_ROLES, telephonyConfiguredOrResponse, telephonyErrorResponse } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;
    const body = await readJsonBody<{ observations?: unknown }>(request);
    const observations = readBrowserCallObservations(body.observations);
    if (!observations.length) return Response.json({ loggedIds: [] });
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const loggedIds = await logBrowserCallObservations(deps, actor.profileId, observations);
    return Response.json({ loggedIds }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Diagnostiku sa nepodarilo prijať.");
  }
}
