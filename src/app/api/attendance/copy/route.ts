import type { CopyAttendanceInput } from "@/data/attendance-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { copyAttendance, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const input = (await request.json()) as CopyAttendanceInput;
    await copyAttendance(input);
    const dispatchData = await loadDispatchData();

    return Response.json({ dispatchData });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Attendance copy failed:", error);
  return Response.json({ error: "Služby sa nepodarilo skopírovať." }, { status: 500 });
}
