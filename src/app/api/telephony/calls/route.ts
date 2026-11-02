import { measureRequestStep, withRequestMetrics } from "@/server/request-metrics";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { startOutboundCall, type StartOutboundResult } from "@/server/telephony/call-actions";
import { respondWhenDialled } from "@/server/telephony/early-start";
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
/** Covers the bookkeeping that may follow an early response (`respondWhenDialled`). */
export const maxDuration = 60;

type OutboundBody = { to?: unknown; caseId?: unknown; lineId?: unknown; callbackTargetVerificationId?: unknown; requestId?: unknown };

/**
 * Click-to-call: dials the operator's own WebRTC leg first, the customer is
 * dialled when that leg answers (design §2.2). The browser auto-answers the
 * invite whose `telnyxCallControlId` matches `operatorLegCallControlId`.
 *
 * With `start_early_response` the 201 leaves once that leg is dialled and
 * recorded; see `respondWhenDialled` for what a client can see afterwards.
 */
export async function POST(request: Request) {
  return withRequestMetrics("call.start", async () => {
    try {
      assertSameOriginRequest(request);
      const actor = await measureRequestStep("auth", () => requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES));
      const notConfigured = telephonyConfiguredOrResponse();
      if (notConfigured) return notConfigured;

      const body = await readJsonBody<OutboundBody>(request);
      const deps = await createTelephonyDeps({ organizationId: actor.organizationId, deviceKind: request.headers.get("x-pm-phone-kind") === "mobile" ? "mobile" : "web" });
      const result = await respondWhenDialled<StartOutboundResult>(deps, (...early) => startOutboundCall(deps, toCallActor(actor), {
        to: readString(body.to) ?? "",
        caseId: readString(body.caseId),
        lineId: readString(body.lineId),
        ...(readString(body.requestId) ? { requestId: readString(body.requestId)! } : {}),
        ...(readString(body.callbackTargetVerificationId) ? { callbackTargetVerificationId: readString(body.callbackTargetVerificationId)! } : {}),
      }, ...early));

      return Response.json({ ok: true, ...result }, { status: 201 });
    } catch (error) {
      return telephonyErrorResponse(error, "Hovor sa nepodarilo vytočiť.");
    }
  }, { operation: "call.outbound" });
}
