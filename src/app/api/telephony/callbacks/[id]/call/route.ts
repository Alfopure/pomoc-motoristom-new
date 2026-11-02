import { callBackRequest, type CallbackCallResult } from "@/server/telephony/callbacks";
import { handleCallbackActionRoute } from "@/server/telephony/callback-route";
import { respondWhenDialled } from "@/server/telephony/early-start";

export const runtime = "nodejs";
/** Covers the bookkeeping that may follow an early response (`respondWhenDialled`). */
export const maxDuration = 60;

/**
 * One-click callback: the same outbound path as the dialer (kill switch, rate
 * limit, allowlist, browser phone), with the session linked to the request.
 * With `start_early_response` the reply leaves once the own leg is dialled
 * and the request row is linked; see `respondWhenDialled`.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCallbackActionRoute(request, context, {
    requiresProvider: true,
    fallback: "Spätné volanie sa nepodarilo spustiť.",
    run: async ({ deps, actor, requestId, body }) => {
      const result = await respondWhenDialled<CallbackCallResult>(deps, (...early) => callBackRequest(deps, actor, requestId, typeof body.verificationId === "string" ? body.verificationId : undefined,
        typeof body.requestId === "string" ? body.requestId : undefined, ...early));
      return {
        request: result.request,
        linked: result.linked,
        sessionId: result.call.sessionId,
        operatorLegCallControlId: result.call.operatorLegCallControlId,
      };
    },
  });
}
