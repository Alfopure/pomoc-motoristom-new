import type { AttendanceDecisionInput } from "@/data/attendance-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { declineAttendanceRequest, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const { id } = await params;
    const input = (await request.json().catch(() => ({}))) as AttendanceDecisionInput;
    const attendanceRequest = await declineAttendanceRequest(id, input.note);
    const dispatchData = await loadDispatchData();

    return Response.json({ requestId: attendanceRequest.id, dispatchData });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Attendance request decline failed:", error);
  return Response.json({ error: "Žiadosť sa nepodarilo zamietnuť." }, { status: 500 });
}
