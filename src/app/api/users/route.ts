import { loadDispatchData, loadAccessUsers } from "@/data/dispatch-repository";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { createAccessUser, type CreateAccessUserInput } from "@/server/access-management";
import { MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    return Response.json({ users: await loadAccessUsers(actor.organizationId) }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const input = (await request.json()) as CreateAccessUserInput;
    const result = await createAccessUser(actor, input, request);
    const dispatchData = await loadDispatchData(actor, { access: true });

    return Response.json({ dispatchData, userId: result.profile.id, notice: result.notice });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("User access operation failed:", error);
  return Response.json({ error: "Správu používateľov sa nepodarilo dokončiť." }, { status: 500 });
}
