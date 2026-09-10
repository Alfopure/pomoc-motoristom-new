import { requireDefaultMotoristActor } from "@/server/api-auth";
import { loadWorkspaceCapabilities } from "@/server/workspace-capabilities";
import { MutationError } from "@/server/mutation-error";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    return Response.json({ capabilities: await loadWorkspaceCapabilities(actor) }, { headers });
  } catch (error) { return Response.json({ error: error instanceof MutationError ? error.message : "Pracovná plocha nie je dostupná." }, { status: error instanceof MutationError ? error.status : 503, headers }); }
}
