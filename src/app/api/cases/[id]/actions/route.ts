import type { CaseActionInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { MutationError, runCaseAction } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { withRequestMetrics } from "@/server/request-metrics";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestMetrics("case.action", async () => {
    let committed = false;
    try {
      assertSameOriginRequest(request);
      const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
      const { id } = await params;
      const input = (await request.json()) as CaseActionInput;
      await runCaseAction(id, input, actor.profileId);
      committed = true;
      const dispatchData = await loadDispatchData();

      return Response.json({ caseId: id, dispatchData });
    } catch (error) {
      if (error instanceof MutationError) {
        return Response.json({ error: error.message }, { status: error.status, headers: committed ? { "x-operation-committed": "true" } : undefined });
      }

      console.error("Case action failed:", error);
      return Response.json({ error: "Rýchlu akciu sa nepodarilo vykonať." }, { status: 500, headers: committed ? { "x-operation-committed": "true" } : undefined });
    }
  });
}
