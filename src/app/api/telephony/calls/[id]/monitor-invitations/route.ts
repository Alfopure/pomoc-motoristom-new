import { CallActionError, inviteCallMonitor, revokeCallMonitorInvitation, superviseCall } from "@/server/telephony/call-actions";
import { handleCallActionRoute } from "@/server/telephony/call-action-route";
import { isUuid } from "@/lib/telephony/uuid";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallActionRoute(request, context, {
    fallback: "Pozvané počúvanie sa nepodarilo zmeniť.",
    run: ({ deps, actor, sessionId, body }) => {
      if (body.action === "invite" && typeof body.recipientProfileId === "string" && isUuid(body.recipientProfileId)) return inviteCallMonitor(deps, actor, sessionId, body.recipientProfileId);
      if (typeof body.invitationId !== "string" || !isUuid(body.invitationId)) throw new CallActionError("Neplatná pozvánka.", 400);
      if (body.action === "accept") {
        if (body.mode !== undefined && body.mode !== "monitor") throw new CallActionError("Poslucháč smie iba počúvať.", 403, "monitor_only");
        return superviseCall(deps, actor, sessionId, "monitor", body.invitationId);
      }
      if (body.action === "revoke") return revokeCallMonitorInvitation(deps, actor, sessionId, body.invitationId);
      throw new CallActionError("Neplatná operácia pozvánky.", 400);
    },
  });
}
