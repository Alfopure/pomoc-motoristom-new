import { handleCallActionRoute } from "@/server/telephony/call-action-route";
import { reconcileBrowserCall } from "@/server/telephony/call-reconciliation";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallActionRoute(request, context, {
    fallback: "Stav hovoru sa nepodarilo overiť.",
    run: ({ deps, actor, sessionId, body }) => reconcileBrowserCall(deps, actor, sessionId, body.callControlId),
  });
}
