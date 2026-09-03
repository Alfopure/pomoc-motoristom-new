import { resolveCallbackRequest } from "@/server/telephony/callbacks";
import { handleCallbackActionRoute } from "@/server/telephony/callback-route";
import { readString } from "@/server/telephony/runtime";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallbackActionRoute(request, context, {
    fallback: "Uzavretie požiadavky zlyhalo.",
    run: ({ queueDeps, actor, requestId, body }) =>
      resolveCallbackRequest(queueDeps, actor, requestId, { status: "done", notes: readString(body.notes) }),
  });
}
