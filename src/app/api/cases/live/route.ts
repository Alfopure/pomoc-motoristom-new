import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { COLLABORATION_ROLES, collaborationBody, collaborationError, collaborationHeaders, loadCaseLiveSnapshot } from "@/server/case-collaboration";
export const runtime = "nodejs";
/** Read-only POST keeps the bounded revision manifest out of URLs and logs. */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor([...COLLABORATION_ROLES]);
    return Response.json(await loadCaseLiveSnapshot(actor, await collaborationBody(request), request.signal), { headers: collaborationHeaders });
  } catch (error) { return collaborationError(error); }
}
