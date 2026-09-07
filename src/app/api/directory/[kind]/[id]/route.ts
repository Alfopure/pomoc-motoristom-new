import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { requireDirectoryKind, saveDirectoryEntry } from "@/server/directory-service";
import { directoryErrorResponse, directorySavedResponse, readDirectoryBody } from "@/server/directory-http";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ kind: string; id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const { kind, id } = await context.params;
    const input = await readDirectoryBody(request);
    return await directorySavedResponse(await saveDirectoryEntry(actor, requireDirectoryKind(kind), input, id));
  } catch (error) { return directoryErrorResponse(error); }
}
