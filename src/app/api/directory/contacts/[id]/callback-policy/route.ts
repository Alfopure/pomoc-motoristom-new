import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readCallbackPolicy, saveCallbackPolicy } from "@/server/callback-targets";
import { directoryErrorResponse, readDirectoryBody } from "@/server/directory-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const { id } = await context.params;
    return Response.json({ policy: await readCallbackPolicy(createSupabaseAdminClient(), actor, id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return directoryErrorResponse(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const { id } = await context.params;
    const policy = await saveCallbackPolicy(createSupabaseAdminClient(), actor, id, await readDirectoryBody(request));
    return Response.json({ policy }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return directoryErrorResponse(error); }
}
