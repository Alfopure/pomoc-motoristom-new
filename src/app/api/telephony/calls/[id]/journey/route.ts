import { requireDefaultMotoristActor } from "@/server/api-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { TELEPHONY_ROUTE_ROLES, telephonyErrorResponse } from "@/server/telephony/runtime";
import { loadCallJourney } from "@/server/telephony/call-journey";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const { id } = await context.params;
    const identity = new URL(request.url).searchParams.get("identity") === "session" ? "session" : "call";
    const journey = await loadCallJourney({ admin: createSupabaseAdminClient(), organizationId: actor.organizationId }, id, identity);
    return Response.json({ ok: true, journey }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) { return telephonyErrorResponse(error, "Priebeh hovoru sa nepodarilo načítať."); }
}
