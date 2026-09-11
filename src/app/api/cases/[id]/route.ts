import { withRequestMetrics, measureRequestStep } from "@/server/request-metrics";
import type { UpdateCaseInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import type { MotoristActor } from "@/server/api-auth";
import { loadCaseDetail } from "@/data/case-detail-repository";
import { MutationError, updateCase } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";

export const runtime = "nodejs";

const roles = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
// Already-open older browsers need their full DTO until those clients drain.
// New clients always opt in, so their save/refresh never reads the dispatch snapshot.
async function caseResponse(request: Request, id: string, actor: MotoristActor) {
  if (request.headers.get("x-case-response") === "detail-v2") {
    return { caseDetail: await loadCaseDetail(id, actor, request.signal) };
  }
  const dispatchData = await loadDispatchData(actor);
  if (dispatchData.source !== "supabase") throw new MutationError("Aktuálny stav karty sa nepodarilo spoľahlivo načítať.", 503);
  return { dispatchData };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestMetrics("case.get", async () => {
    try {
      const actor = await measureRequestStep("auth", () => requireDefaultMotoristActor([...roles]));
      const { id } = await params;
      const result = await measureRequestStep("read", () => caseResponse(request, id, actor));
      return Response.json(result, { headers });
    } catch (error) {
      return Response.json({ error: error instanceof MutationError ? error.message : "Aktuálny stav karty sa nepodarilo načítať." },
        { status: error instanceof MutationError ? error.status : 503, headers });
    }
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestMetrics("case.save", async () => {
    try {
      assertSameOriginRequest(request);
      const actor = await measureRequestStep("auth", () => requireDefaultMotoristActor([...roles]));
      const { id } = await params;
      const input = (await request.json()) as UpdateCaseInput;
      const { caseRow, warnings } = await measureRequestStep("write", () => updateCase(id, input, actor.profileId, actor.organizationId));

      try {
        const result = await measureRequestStep("read", () => caseResponse(request, id, actor));
        return Response.json({ caseId: caseRow.id, committedRevision: caseRow.updated_at, mutationId: input.mutationId, ...result, warnings }, { headers });
      } catch (refreshError) {
        console.error("Case update succeeded but canonical refresh failed:", refreshError);
      }

      // The mutation already committed. Tell the client to reconcile with a safe GET
      // instead of returning an error that could trigger a duplicate PATCH.
      return Response.json({ caseId: caseRow.id, committedRevision: caseRow.updated_at, mutationId: input.mutationId, refreshRequired: true, warnings }, { headers });
    } catch (error) {
      if (error instanceof MutationError) {
        return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
      }

      console.error("Case update failed:", error);
      return Response.json({ error: "Kartu zásahu sa nepodarilo upraviť." }, { status: 500 });
    }
  });
}
