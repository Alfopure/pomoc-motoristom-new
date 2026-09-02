import { loadDispatchData } from "@/data/dispatch-repository";
import { MutationError, publishAttendanceShift } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const { id } = await params;
    const shift = await publishAttendanceShift(id);
    const dispatchData = await loadDispatchData();

    return Response.json({ shiftId: shift.id, dispatchData });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Attendance publish failed:", error);
  return Response.json({ error: "Službu sa nepodarilo publikovať." }, { status: 500 });
}
