import type { CaseActionInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { MutationError, runCaseAction } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const { id } = await params;
    const input = (await request.json()) as CaseActionInput;
    await runCaseAction(id, input, actor.profileId);
    const dispatchData = await loadDispatchData();

    return Response.json({ caseId: id, dispatchData });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Case action failed:", error);
    return Response.json({ error: "Rýchlu akciu sa nepodarilo vykonať." }, { status: 500 });
  }
}
