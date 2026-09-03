import { callBackRequest } from "@/server/telephony/callbacks";
import { handleCallbackActionRoute } from "@/server/telephony/callback-route";

export const runtime = "nodejs";

/**
 * One-click callback: the same outbound path as the dialer (kill switch, rate
 * limit, allowlist, browser phone), with the session linked to the request.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallbackActionRoute(request, context, {
    requiresProvider: true,
    fallback: "Spätné volanie sa nepodarilo spustiť.",
    run: async ({ deps, actor, requestId }) => {
      const result = await callBackRequest(deps, actor, requestId);
      return {
        request: result.request,
        linked: result.linked,
        sessionId: result.call.sessionId,
        operatorLegCallControlId: result.call.operatorLegCallControlId,
      };
    },
  });
}
