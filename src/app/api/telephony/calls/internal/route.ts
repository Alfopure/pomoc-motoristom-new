import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { callColleague } from "@/server/telephony/call-actions";
import {
  createTelephonyDeps,
  readJsonBody,
  readString,
  TELEPHONY_ROUTE_ROLES,
  telephonyConfiguredOrResponse,
  telephonyErrorResponse,
  toCallActor,
} from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Internal call between two operators (both legs are WebRTC). */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const body = await readJsonBody<{ targetProfileId?: unknown }>(request);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const result = await callColleague(deps, toCallActor(actor), { targetProfileId: readString(body.targetProfileId) ?? "" });

    return Response.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return telephonyErrorResponse(error, "Interný hovor sa nepodarilo vytočiť.");
  }
}
