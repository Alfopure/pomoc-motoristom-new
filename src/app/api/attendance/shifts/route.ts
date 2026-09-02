import type { CreateAttendanceShiftInput } from "@/data/attendance-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { createAttendanceShift, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const input = (await request.json()) as CreateAttendanceShiftInput;
    const shift = await createAttendanceShift(input);
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

  console.error("Attendance shift mutation failed:", error);
  return Response.json({ error: "Službu sa nepodarilo uložiť." }, { status: 500 });
}
