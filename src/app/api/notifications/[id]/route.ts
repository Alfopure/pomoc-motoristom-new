import { loadDispatchNotifications } from "@/data/dispatch-repository";
import { MutationError, snoozeNotification, updateNotificationStatus } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["dispatcher", "manager", "admin"]);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { snoozedUntil?: unknown; status?: unknown };
    if (typeof body.snoozedUntil === "string") {
      await snoozeNotification(id, body.snoozedUntil, {
        id: actor.profileId,
        organization_id: actor.organizationId,
      });
      const notifications = await loadDispatchNotifications(actor.organizationId);

      return Response.json({ notificationId: id, notifications });
    }

    const status = body.status;

    if (status !== "unread" && status !== "read" && status !== "archived") {
      throw new MutationError("Neplatný stav notifikácie.", 400);
    }

    await updateNotificationStatus(id, status);
    const notifications = await loadDispatchNotifications(actor.organizationId);

    return Response.json({ notificationId: id, notifications });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Notification status mutation failed:", error);
    return Response.json({ error: "Notifikáciu sa nepodarilo upraviť." }, { status: 500 });
  }
}
