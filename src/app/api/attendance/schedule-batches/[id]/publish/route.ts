import { loadDispatchData } from "@/data/dispatch-repository";
import { MutationError, publishAttendanceScheduleBatch } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const { id } = await params;
    const batch = await publishAttendanceScheduleBatch(id);
    const dispatchData = await loadDispatchData();

    return Response.json({ batchId: batch.id, dispatchData });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Attendance schedule publish failed:", error);
  return Response.json({ error: "Plán sa nepodarilo publikovať." }, { status: 500 });
}
