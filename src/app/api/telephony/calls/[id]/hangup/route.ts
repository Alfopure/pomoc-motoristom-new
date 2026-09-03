import { hangupCall } from "@/server/telephony/call-actions";
import { handleCallActionRoute } from "@/server/telephony/call-action-route";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallActionRoute(request, context, {
    fallback: "Ukončenie hovoru zlyhalo.",
    run: ({ deps, actor, sessionId }) => hangupCall(deps, actor, sessionId),
  });
}
