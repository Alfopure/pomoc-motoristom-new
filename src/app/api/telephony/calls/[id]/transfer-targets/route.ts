import { requireDefaultMotoristActor } from "@/server/api-auth";
import { listTransferTargets } from "@/server/telephony/call-actions";
import { createTelephonyDeps, TELEPHONY_ROUTE_ROLES, telephonyConfiguredOrResponse, telephonyErrorResponse, toCallActor } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Colleagues that can take a transfer/consult right now (design §4 Phase 2). */
export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const targets = await listTransferTargets(deps, toCallActor(actor));

    return Response.json({ targets }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Ciele prepojenia sa nepodarilo načítať.");
  }
}
