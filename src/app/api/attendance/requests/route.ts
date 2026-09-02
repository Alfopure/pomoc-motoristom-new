import type { CreateAttendanceRequestInput } from "@/data/attendance-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { createAttendanceRequest, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgMember } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgMember();
    const input = (await request.json()) as CreateAttendanceRequestInput;
    const attendanceRequest = await createAttendanceRequest(input);
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

  console.error("Attendance request create failed:", error);
  return Response.json({ error: "Žiadosť sa nepodarilo uložiť." }, { status: 500 });
}
