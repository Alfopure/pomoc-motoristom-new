import type { EndAttendanceSessionInput } from "@/data/attendance-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { endAttendanceSession, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgMember } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgMember();
    const { id } = await params;
    const input = (await request.json().catch(() => ({}))) as EndAttendanceSessionInput;
    const session = await endAttendanceSession(id, input);
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

  console.error("Attendance session end failed:", error);
  return Response.json({ error: "Dochádzku sa nepodarilo ukončiť." }, { status: 500 });
}
