import { claimCallbackRequest } from "@/server/telephony/callbacks";
import { handleCallbackActionRoute } from "@/server/telephony/callback-route";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallbackActionRoute(request, context, {
    fallback: "Prevzatie požiadavky zlyhalo.",
    run: ({ queueDeps, actor, requestId }) => claimCallbackRequest(queueDeps, actor, requestId),
  });
}
