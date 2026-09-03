import { cancelConsult } from "@/server/telephony/call-actions";
import { handleCallActionRoute } from "@/server/telephony/call-action-route";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallActionRoute(request, context, {
    fallback: "Zrušenie konzultácie zlyhalo.",
    run: ({ deps, actor, sessionId }) => cancelConsult(deps, actor, sessionId),
  });
}
