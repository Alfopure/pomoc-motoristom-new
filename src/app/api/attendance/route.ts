import { loadAttendanceData } from "@/data/dispatch-repository";
import { requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
export async function GET(request: Request) {
  try {
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    return Response.json({ attendance: await loadAttendanceData(actor.organizationId, request.signal) }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) {
    return Response.json({ error: error instanceof MutationError ? error.message : "Dochádzku sa nepodarilo načítať." }, { status: error instanceof MutationError ? error.status : 503 });
  }
}
