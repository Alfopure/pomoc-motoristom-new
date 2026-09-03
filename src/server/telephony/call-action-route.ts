import "server-only";

import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";

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
 * Shared body of the `POST /api/telephony/calls/[id]/…` routes.
 *
 * Order is fixed by the security contract: CSRF same-origin check first (so a
 * mismatched Origin is 403 even for an anonymous request, see
 * `route-csrf.test.ts`), then the session guard, then the
 * telephony-not-configured gate, then the action itself.
 */

export type CallActionRouteInput = {
  deps: TelephonyRuntimeDeps;
  actor: CallActor;
  sessionId: string;
  body: Record<string, unknown>;
  request: Request;
};

export type CallActionRouteOptions = {
  fallback: string;
  run: (input: CallActionRouteInput) => Promise<unknown>;
};

export async function handleCallActionRoute(
  request: Request,
  context: { params: Promise<{ id: string }> },
  options: CallActionRouteOptions,
): Promise<Response> {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const { id } = await context.params;
    const body = await readJsonBody(request);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const result = await options.run({ deps, actor: toCallActor(actor), sessionId: id, body, request });

    return Response.json({ ok: true, ...(result && typeof result === "object" ? result : {}) });
  } catch (error) {
    return telephonyErrorResponse(error, options.fallback);
  }
}

/** `{ profileId, number }` transfer/consult target from a request body. */
export function readTransferTarget(body: Record<string, unknown>): { profileId: string | null; number: string | null } {
  const profileId = typeof body.profileId === "string" && body.profileId.trim() ? body.profileId.trim() : null;
  const number = typeof body.number === "string" && body.number.trim() ? body.number.trim() : null;
  return { profileId, number };
}
