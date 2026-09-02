import type { AssignCaseInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { assignCase, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const { id } = await params;
    const input = (await request.json()) as AssignCaseInput;
    await assignCase(id, input, actor.profileId);
    const dispatchData = await loadDispatchData();

    return Response.json({ caseId: id, dispatchData });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }

    console.error("Assign mutation failed:", error);
    return Response.json({ error: "Techniku sa nepodarilo priradiť." }, { status: 500 });
  }
}
