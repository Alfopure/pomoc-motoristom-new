import type { CreateCaseInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { createCase, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { editorSessionId, finishCaseEditorDraft } from "@/server/case-collaboration";
import { withRequestMetrics } from "@/server/request-metrics";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return withRequestMetrics("case.create", async () => {
    let committed = false;
    try {
      assertSameOriginRequest(request);
      const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
      const input = (await request.json()) as CreateCaseInput & { editorSessionId?: string | null };
      const sessionId = input.editorSessionId ? editorSessionId(input.editorSessionId) : null;
      const { caseRow, warnings } = await createCase(input, actor.profileId);
      committed = true;
      if (sessionId) {
        try { await finishCaseEditorDraft(actor, sessionId, caseRow.id); }
        catch { /* The case is committed; a disconnected placeholder expires within 60 seconds. */ }
      }
      const dispatchData = await loadDispatchData();

      return Response.json({ caseId: caseRow.id, dispatchData, warnings });
    } catch (error) {
      const response = mutationErrorResponse(error);
      if (committed) response.headers.set("x-operation-committed", "true");
      return response;
    }
  });
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Case mutation failed:", error);
  return Response.json({ error: "Operáciu sa nepodarilo dokončiť." }, { status: 500 });
}
