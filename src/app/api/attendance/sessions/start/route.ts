import type { StartAttendanceSessionInput } from "@/data/attendance-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { MutationError, startAttendanceSession } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgMember } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgMember();
    const input = (await request.json()) as StartAttendanceSessionInput;
    const session = await startAttendanceSession(input);
    const dispatchData = await loadDispatchData();

    return Response.json({ sessionId: session.id, dispatchData });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Attendance session start failed:", error);
  return Response.json({ error: "Dochádzku sa nepodarilo spustiť." }, { status: 500 });
}
