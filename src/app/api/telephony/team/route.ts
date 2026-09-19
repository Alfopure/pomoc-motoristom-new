import { requireDefaultMotoristActor } from "@/server/api-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { MutationError } from "@/server/mutation-error";
import { loadTelephonyTeam } from "@/server/telephony/team";

export const runtime = "nodejs";
export async function GET() {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  try {
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const payload = await loadTelephonyTeam({ admin: createSupabaseAdminClient(), organizationId: actor.organizationId });
    return Response.json(payload, { headers });
  } catch (error) {
    return Response.json({ error: "Prehľad operátorov sa nepodarilo načítať." }, { status: error instanceof MutationError ? error.status : 503, headers });
  }
}
