import { blindTransfer } from "@/server/telephony/call-actions";
import { handleCallActionRoute, readTransferTarget } from "@/server/telephony/call-action-route";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallActionRoute(request, context, {
    fallback: "Prepojenie zlyhalo.",
    run: ({ deps, actor, sessionId, body }) => blindTransfer(deps, actor, sessionId, readTransferTarget(body)),
  });
}
