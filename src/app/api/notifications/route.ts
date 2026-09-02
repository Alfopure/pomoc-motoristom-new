import { loadDispatchNotifications } from "@/data/dispatch-repository";
import { requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(["dispatcher", "manager", "admin"]);
    const notifications = await loadDispatchNotifications(actor.organizationId);
    return Response.json({ notifications });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Notification list failed:", error);
    return Response.json({ error: "Notifikácie sa nepodarilo načítať." }, { status: 500 });
  }
}
