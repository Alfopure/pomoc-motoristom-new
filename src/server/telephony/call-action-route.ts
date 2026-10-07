import "server-only";
import { after } from "next/server";

import { measureRequestStep, withRequestMetrics, withBackgroundRequestMetrics } from "@/server/request-metrics";

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

export type CallActionRouteParams = { id: string };

export type CallActionRouteInput<P extends CallActionRouteParams = CallActionRouteParams> = {
  deps: TelephonyRuntimeDeps;
  actor: CallActor;
  sessionId: string;
  /** Every dynamic segment of the route (`parties/[legId]/…` needs `legId`). */
  params: P;
  body: Record<string, unknown>;
  request: Request;
};

export type CallActionRouteOptions<P extends CallActionRouteParams = CallActionRouteParams> = {
  fallback: string;
  run: (input: CallActionRouteInput<P>) => Promise<unknown>;
  /** Read-only reconciliation must not enqueue more work while the call is busy;
   *  a reconciliation that did apply a transition (`reconciled: true`) drains
   *  the session's deferred facts after release like any other action. */
  replayDeferred?: boolean;
};

export async function handleCallActionRoute<P extends CallActionRouteParams = CallActionRouteParams>(
  request: Request,
  context: { params: Promise<P> },
  options: CallActionRouteOptions<P>,
): Promise<Response> {
  // Hangup's route retains work for 60 s including its foreground request.
  // Keep the accepted continuation inside that same invocation's budget.
  const hangupRecoveryDeadline = Date.now() + 55_000;
  return withRequestMetrics("call.action", async () => {
    try {
      assertSameOriginRequest(request);
      const actor = await measureRequestStep("auth", () => requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES));
      const notConfigured = telephonyConfiguredOrResponse();
      if (notConfigured) return notConfigured;

      const params = await context.params;
      const body = await readJsonBody(request);
      const deps = await createTelephonyDeps({ organizationId: actor.organizationId, deviceKind: request.headers.get("x-pm-phone-kind") === "mobile" ? "mobile" : "web" });
      const result = await options.run({ deps, actor: toCallActor(actor), sessionId: params.id, params, body, request });

      // A customer hangup/answer can arrive while this action owns the call.
      // Once the action has completed and released ownership, recover its exact
      // queued facts without waiting for provider redelivery or the cron.
      const applied = result && typeof result === "object" && "sessionId" in result && result.sessionId === params.id;
      const terminationPending = applied && "terminationPending" in result && result.terminationPending === true;
      const reconciled = applied && "reconciled" in result && result.reconciled === true;
      if (applied && (options.replayDeferred !== false || reconciled)) {
        const reportDeferred = (code = "event_replay_deferred") => {
          try { deps.logger?.({ level: "warn", scope: "call-action", sessionId: params.id, code }); }
          catch { /* Optional diagnostics cannot invalidate the completed action. */ }
        };
        try {
          after(withBackgroundRequestMetrics(async () => {
            if (terminationPending) {
              try {
                const { continueAcceptedHangup } = await import("./call-actions");
                await continueAcceptedHangup(deps, params.id, hangupRecoveryDeadline);
              } catch { reportDeferred("termination_completion_deferred"); }
              // This continuation already resumes durable session effects.
              // Do not start another lease/drain after spending its host budget;
              // provider callbacks retain their own terminal-fact recovery.
              return;
            }
            try {
              const { replayDeferredSessionEvents } = await import("./telnyx/event-processor");
              await replayDeferredSessionEvents(deps, params.id);
            } catch { reportDeferred(); }
            try {
              const { recoverSessionContactChecks } = await import("./session-runner");
              await recoverSessionContactChecks(deps, params.id);
            } catch { reportDeferred("contact_verification_deferred"); }
          }));
        } catch { reportDeferred(); }
      }

      return Response.json({ ok: true, ...(result && typeof result === "object" ? result : {}) }, { status: terminationPending ? 202 : 200 });
    } catch (error) {
      return telephonyErrorResponse(error, options.fallback);
    }
  });
}

/** `{ profileId, number }` transfer/consult target from a request body. */
export function readTransferTarget(body: Record<string, unknown>): { profileId: string | null; number: string | null } {
  const profileId = typeof body.profileId === "string" && body.profileId.trim() ? body.profileId.trim() : null;
  const number = typeof body.number === "string" && body.number.trim() ? body.number.trim() : null;
  return { profileId, number };
}
