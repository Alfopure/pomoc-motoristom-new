import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { COLLABORATION_ROLES, collaborationBody, collaborationError, collaborationHeaders, updateCaseEditorPresence } from "@/server/case-collaboration";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor([...COLLABORATION_ROLES]);
    return Response.json(await updateCaseEditorPresence(actor, await collaborationBody(request)), { headers: collaborationHeaders });
  } catch (error) { return collaborationError(error); }
}
