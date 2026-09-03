import { stopSupervisingCall } from "@/server/telephony/call-actions";
import { handleCallActionRoute } from "@/server/telephony/call-action-route";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallActionRoute(request, context, {
    fallback: "Dozor sa nepodarilo ukončiť.",
    run: ({ deps, actor, sessionId }) => stopSupervisingCall(deps, actor, sessionId),
  });
}
