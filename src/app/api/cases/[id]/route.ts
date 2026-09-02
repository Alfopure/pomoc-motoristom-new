import type { UpdateCaseInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { MutationError, updateCase } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristActor, requireDefaultMotoristOrgMember } from "@/server/api-auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireDefaultMotoristOrgMember();
    const dispatchData = await loadDispatchData();

    if (dispatchData.source !== "supabase") {
      return Response.json(
        { error: "Aktuálny stav karty sa nepodarilo spoľahlivo načítať." },
        { status: 503 },
      );
    }

    return Response.json({ dispatchData });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Case refresh failed:", error);
    return Response.json({ error: "Aktuálny stav karty sa nepodarilo načítať." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const { id } = await params;
    const input = (await request.json()) as UpdateCaseInput;
    const { caseRow, warnings } = await updateCase(id, input, actor.profileId);

    try {
      const dispatchData = await loadDispatchData();
      if (dispatchData.source === "supabase") {
        return Response.json({ caseId: caseRow.id, dispatchData, warnings });
      }
    } catch (refreshError) {
      console.error("Case update succeeded but canonical refresh failed:", refreshError);
    }

    // The mutation already committed. Tell the client to reconcile with a safe GET
    // instead of returning an error that could trigger a duplicate PATCH.
    return Response.json({ caseId: caseRow.id, refreshRequired: true, warnings });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Case update failed:", error);
    return Response.json({ error: "Kartu zásahu sa nepodarilo upraviť." }, { status: 500 });
  }
}
