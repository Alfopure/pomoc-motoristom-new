import type { CreateBulkAttendanceShiftsInput } from "@/data/attendance-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { createBulkAttendanceShifts, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const input = (await request.json()) as CreateBulkAttendanceShiftsInput;
    const batch = await createBulkAttendanceShifts(input);
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

  console.error("Attendance bulk planning failed:", error);
  return Response.json({ error: "Plán smien sa nepodarilo uložiť." }, { status: 500 });
}
