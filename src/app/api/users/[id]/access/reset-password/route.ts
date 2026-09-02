import { loadDispatchData } from "@/data/dispatch-repository";
import { requireDefaultMotoristActor, assertSameOriginRequest } from "@/server/api-auth";
import { sendAccessLink } from "@/server/access-management";
import { MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const { id } = await params;
    const delivery = await sendAccessLink(actor, id, "reset_password", request);
    const dispatchData = await loadDispatchData();

    return Response.json({ dispatchData, delivery: { status: delivery.status, messageId: delivery.status === "sent" ? delivery.messageId : null } });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Password reset send failed:", error);
  return Response.json({ error: "Reset hesla sa nepodarilo odoslať." }, { status: 500 });
}
