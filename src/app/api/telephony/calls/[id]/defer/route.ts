import { CallActionError, deferRingingCall } from "@/server/telephony/call-actions";
import { handleCallActionRoute } from "@/server/telephony/call-action-route";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallActionRoute(request, context, {
    fallback: "Odloženie hovoru do čakárne zlyhalo.",
    run: ({ deps, actor, sessionId, body }) => {
      const callControlId = typeof body.callControlId === "string" ? body.callControlId.trim() : "";
      if (!callControlId) throw new CallActionError("Chýba identifikátor zvoniaceho hovoru.", 400, "offer_required");
      return deferRingingCall(deps, actor, sessionId, callControlId);
    },
  });
}
