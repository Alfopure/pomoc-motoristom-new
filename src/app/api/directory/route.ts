import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { DIRECTORY_READ_ROLES, loadDirectory, requireDirectoryKind, saveDirectoryEntry } from "@/server/directory-service";
import { directoryErrorResponse, directorySavedResponse, readDirectoryBody } from "@/server/directory-http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(DIRECTORY_READ_ROLES);
    return Response.json(await loadDirectory(actor), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return directoryErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const input = await readDirectoryBody(request);
    const kind = requireDirectoryKind(input && typeof input === "object" && "kind" in input ? input.kind : null);
    return await directorySavedResponse(await saveDirectoryEntry(actor, kind, input));
  } catch (error) { return directoryErrorResponse(error); }
}
