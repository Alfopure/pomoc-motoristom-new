import { CallActionError, superviseCall } from "@/server/telephony/call-actions";
import { handleCallActionRoute } from "@/server/telephony/call-action-route";
import { isSupervisorMode } from "@/server/telephony/state/types";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallActionRoute(request, context, {
    fallback: "Dozor nad hovorom sa nepodarilo spustiť.",
    run: ({ deps, actor, sessionId, body }) => {
      const mode = body.mode;
      if (!isSupervisorMode(mode)) throw new CallActionError("Neplatný režim dozoru.", 400, "invalid_mode");
      return superviseCall(deps, actor, sessionId, mode);
    },
  });
}
