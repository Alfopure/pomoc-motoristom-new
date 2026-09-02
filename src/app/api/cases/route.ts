import type { CreateCaseInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { createCase, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const input = (await request.json()) as CreateCaseInput;
    const { caseRow, warnings } = await createCase(input, actor.profileId);
    const dispatchData = await loadDispatchData();

    return Response.json({ caseId: caseRow.id, dispatchData, warnings });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Case mutation failed:", error);
  return Response.json({ error: "Operáciu sa nepodarilo dokončiť." }, { status: 500 });
}
