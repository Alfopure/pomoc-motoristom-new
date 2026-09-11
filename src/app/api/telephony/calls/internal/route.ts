import { measureRequestStep, withRequestMetrics } from "@/server/request-metrics";
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
  return withRequestMetrics("call.start", async () => {
    try {
      assertSameOriginRequest(request);
      const actor = await measureRequestStep("auth", () => requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES));
      const notConfigured = telephonyConfiguredOrResponse();
      if (notConfigured) return notConfigured;

      const body = await readJsonBody<{ targetProfileId?: unknown; requestId?: unknown }>(request);
      const deps = await createTelephonyDeps({ organizationId: actor.organizationId, deviceKind: request.headers.get("x-pm-phone-kind") === "mobile" ? "mobile" : "web" });
      const result = await callColleague(deps, toCallActor(actor), { targetProfileId: readString(body.targetProfileId) ?? "",
        ...(readString(body.requestId) ? { requestId: readString(body.requestId)! } : {}) });

      return Response.json({ ok: true, ...result }, { status: 201 });
    } catch (error) {
      return telephonyErrorResponse(error, "Interný hovor sa nepodarilo vytočiť.");
    }
  });
}
