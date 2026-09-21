import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { COLLABORATION_ROLES, collaborationError, collaborationHeaders } from "@/server/case-collaboration";
import { caseDraftPreviewBody, loadCaseDraftPreview, publishCaseDraftPreview } from "@/server/case-draft-preview";

export const runtime = "nodejs";
type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const actor = await requireDefaultMotoristActor([...COLLABORATION_ROLES]);
    const { sessionId } = await context.params;
    return Response.json(await loadCaseDraftPreview(actor, sessionId, request.signal), { headers: collaborationHeaders });
  } catch (error) { return collaborationError(error); }
}

export async function PUT(request: Request, context: Context) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor([...COLLABORATION_ROLES]);
    const { sessionId } = await context.params;
    return Response.json(await publishCaseDraftPreview(actor, sessionId, await caseDraftPreviewBody(request), request.signal), { headers: collaborationHeaders });
  } catch (error) { return collaborationError(error); }
}
