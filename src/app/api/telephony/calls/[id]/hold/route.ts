import { holdCall } from "@/server/telephony/call-actions";
import { handleCallActionRoute } from "@/server/telephony/call-action-route";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallActionRoute(request, context, {
    fallback: "Podržanie hovoru zlyhalo.",
    // `hold_fast_web` (call-speed S7a.5): the named event's last command may answer early.
    confirmControl: "hold",
    run: ({ deps, actor, sessionId, eventId }) => eventId ? holdCall(deps, actor, sessionId, { id: eventId }) : holdCall(deps, actor, sessionId),
  });
}
