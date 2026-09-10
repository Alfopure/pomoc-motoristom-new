import { MutationError, markNotificationRead } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const { id } = await params;
    await markNotificationRead(id, { id: actor.profileId, organization_id: actor.organizationId });

    return Response.json({ notificationId: id });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Notification read mutation failed:", error);
    return Response.json({ error: "Notifikáciu sa nepodarilo označiť ako prečítanú." }, { status: 500 });
  }
}
