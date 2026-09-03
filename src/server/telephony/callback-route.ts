import "server-only";

import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";

import type { CallbackQueueDeps } from "./callbacks";
import type { CallActor } from "./call-actions";
import {
  createTelephonyDeps,
  readJsonBody,
  TELEPHONY_ROUTE_ROLES,
  telephonyConfiguredOrResponse,
  telephonyErrorResponse,
  toCallActor,
  type TelephonyRuntimeDeps,
} from "./runtime";

/**
 * Shared body of the `POST /api/telephony/callbacks/[id]/…` routes.
 *
 * Same order as `call-action-route.ts` and for the same reason: the CSRF
 * same-origin check runs first (a mismatched Origin is 403 even for an
 * anonymous request, see `route-csrf.test.ts`), then the session guard, then
 * the action.
 *
 * Unlike the call-control routes, the provider gate is opt-in. Claiming,
 * closing and cancelling a request are database bookkeeping: a dispatcher must
 * be able to clear the queue with the kill switch off, or the promise made to
 * those callers could never be settled. Only ringing the caller back needs a
 * live provider (`requiresProvider`).
 */

export type CallbackActionRouteInput = {
  deps: TelephonyRuntimeDeps;
  /** The same dependencies narrowed to what the queue service takes. */
  queueDeps: CallbackQueueDeps;
  actor: CallActor;
  requestId: string;
  body: Record<string, unknown>;
  request: Request;
};

export type CallbackActionRouteOptions = {
  fallback: string;
  requiresProvider?: boolean;
  run: (input: CallbackActionRouteInput) => Promise<unknown>;
};

export function callbackQueueDeps(deps: TelephonyRuntimeDeps): CallbackQueueDeps {
  return { admin: deps.admin, organizationId: deps.organizationId, now: deps.now, logger: deps.logger };
}

export async function handleCallbackActionRoute(
  request: Request,
  context: { params: Promise<{ id: string }> },
  options: CallbackActionRouteOptions,
): Promise<Response> {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    if (options.requiresProvider) {
      const notConfigured = telephonyConfiguredOrResponse();
      if (notConfigured) return notConfigured;
    }

    const { id } = await context.params;
    const body = await readJsonBody(request);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const result = await options.run({
      deps,
      queueDeps: callbackQueueDeps(deps),
      actor: toCallActor(actor),
      requestId: id,
      body,
      request,
    });

    return Response.json({ ok: true, ...(result && typeof result === "object" ? result : {}) });
  } catch (error) {
    return telephonyErrorResponse(error, options.fallback);
  }
}
