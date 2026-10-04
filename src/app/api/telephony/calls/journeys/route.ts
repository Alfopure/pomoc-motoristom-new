import { requireDefaultMotoristActor } from "@/server/api-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { TELEPHONY_ROUTE_ROLES, telephonyErrorResponse } from "@/server/telephony/runtime";
import { loadActiveCallJourneys } from "@/server/telephony/call-journey";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const lineId = new URL(request.url).searchParams.get("lineId") ?? undefined;
    const result = await loadActiveCallJourneys({ admin: createSupabaseAdminClient(), organizationId: actor.organizationId }, lineId);
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) { return telephonyErrorResponse(error, "Priebeh hovorov sa nepodarilo načítať."); }
}
