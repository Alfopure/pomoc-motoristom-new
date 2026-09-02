import type { AttendanceDecisionInput } from "@/data/attendance-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { confirmAttendanceShift, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgMember } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgMember();
    const { id } = await params;
    const input = (await request.json().catch(() => ({}))) as AttendanceDecisionInput;
    const shift = await confirmAttendanceShift(id, input.note);
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

  console.error("Attendance confirmation failed:", error);
  return Response.json({ error: "Službu sa nepodarilo potvrdiť." }, { status: 500 });
}
