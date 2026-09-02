import { loadDispatchData } from "@/data/dispatch-repository";
import { updateAccessUser, type UpdateAccessUserInput } from "@/server/access-management";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const { id } = await params;
    const input = (await request.json()) as UpdateAccessUserInput;
    await updateAccessUser(actor, id, input);
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

  console.error("User update failed:", error);
  return Response.json({ error: "Používateľa sa nepodarilo uložiť." }, { status: 500 });
}
