import { requireDefaultMotoristActor } from "@/server/api-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveCallbackTarget } from "@/server/callback-targets";
import { directoryErrorResponse } from "@/server/directory-http";
import { MutationError } from "@/server/mutation-error";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const number = new URL(request.url).searchParams.get("number");
    if (!number || number.length > 100) throw new MutationError("Neplatné telefónne číslo.", 400);
    const target = await resolveCallbackTarget(createSupabaseAdminClient(), actor.organizationId, number);
    return Response.json({ target }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return directoryErrorResponse(error); }
}
