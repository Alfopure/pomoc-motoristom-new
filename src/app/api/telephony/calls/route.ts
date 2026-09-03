import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { startOutboundCall } from "@/server/telephony/call-actions";
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

type OutboundBody = { to?: unknown; caseId?: unknown; lineId?: unknown };

/**
 * Click-to-call: dials the operator's own WebRTC leg first, the customer is
 * dialled when that leg answers (design §2.2). The browser auto-answers the
 * invite whose `telnyxCallControlId` matches `operatorLegCallControlId`.
 */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const body = await readJsonBody<OutboundBody>(request);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const result = await startOutboundCall(deps, toCallActor(actor), {
      to: readString(body.to) ?? "",
      caseId: readString(body.caseId),
      lineId: readString(body.lineId),
    });

    return Response.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return telephonyErrorResponse(error, "Hovor sa nepodarilo vytočiť.");
  }
}
