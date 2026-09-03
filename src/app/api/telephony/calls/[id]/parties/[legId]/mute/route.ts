import { setCallPartyMuted } from "@/server/telephony/call-actions";
import { handleCallActionRoute } from "@/server/telephony/call-action-route";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string; legId: string }> }) {
  return handleCallActionRoute<{ id: string; legId: string }>(request, context, {
    fallback: "Účastníka sa nepodarilo stlmiť.",
    run: ({ deps, actor, sessionId, params }) => setCallPartyMuted(deps, actor, sessionId, params.legId, true),
  });
}
