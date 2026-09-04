import { loadDispatchData } from "@/data/dispatch-repository";
import { deleteAccessUser, updateAccessUser, type UpdateAccessUserInput } from "@/server/access-management";
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

/**
 * Deletes the user's identity, Auth account and Telnyx credentials. Profiles
 * with operational history become hidden, anonymised tombstones so attendance
 * and historical call reports survive.
 *
 * Admin only — deactivation is the reversible action managers get, deletion is
 * not reversible and takes the login with it.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["admin"]);
    const { id } = await params;
    const result = await deleteAccessUser(actor, id);
    const dispatchData = await loadDispatchData();
    const completion =
      result.mode === "anonymised"
        ? `Účet ${result.displayName} bol vymazaný. Pracovná história zostala zachovaná bez aktívneho používateľského účtu.`
        : `Účet ${result.displayName} bol vymazaný.`;
    const notice = result.authWarning ? `${completion} ${result.authWarning}` : completion;

    return Response.json({ dispatchData, notice });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("User deletion failed:", error);
    return Response.json({ error: "Používateľa sa nepodarilo vymazať." }, { status: 500 });
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("User update failed:", error);
  return Response.json({ error: "Používateľa sa nepodarilo uložiť." }, { status: 500 });
}
