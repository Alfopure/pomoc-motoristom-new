import { requireDefaultMotoristActor } from "@/server/api-auth";
import { listMonitorInvitations } from "@/server/telephony/monitor-invitations";
import { createTelephonyDeps, TELEPHONY_ROUTE_ROLES, telephonyErrorResponse, toCallActor } from "@/server/telephony/runtime";
export const runtime = "nodejs";
export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    return Response.json(await listMonitorInvitations(deps, toCallActor(actor)), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return telephonyErrorResponse(error, "Pozvánky sa nepodarilo načítať."); }
}
