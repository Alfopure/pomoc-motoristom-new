import type { UpdateAttendanceShiftInput } from "@/data/attendance-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { MutationError, updateAttendanceShift } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const { id } = await params;
    const input = (await request.json()) as UpdateAttendanceShiftInput;
    const shift = await updateAttendanceShift(id, input);
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

  console.error("Attendance shift update failed:", error);
  return Response.json({ error: "Službu sa nepodarilo upraviť." }, { status: 500 });
}
