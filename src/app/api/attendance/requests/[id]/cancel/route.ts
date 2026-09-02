import { loadDispatchData } from "@/data/dispatch-repository";
import { cancelAttendanceRequest, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgMember } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgMember();
    const { id } = await params;
    const attendanceRequest = await cancelAttendanceRequest(id);
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

  console.error("Attendance request cancel failed:", error);
  return Response.json({ error: "Žiadosť sa nepodarilo zrušiť." }, { status: 500 });
}
