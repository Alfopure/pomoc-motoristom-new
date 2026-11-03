import "server-only";
import { randomUUID } from "node:crypto";
import { callPerformanceOperation } from "@/lib/telephony/performance-operation";
import { after } from "next/server";

import { measureRequestStep, withRequestMetrics, withBackgroundRequestMetrics } from "@/server/request-metrics";

import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";

import type { CallActor } from "./call-actions";
import { observeCommandSettlement, type CommandSettled } from "./command-settlement";
import { latencyFlagsOf } from "./latency-flags";
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
  /** Set only for a control answered early (`confirmControl`): the action must run under this event id. */
  eventId?: string;
};

export type CallActionRouteOptions<P extends CallActionRouteParams = CallActionRouteParams> = {
  fallback: string;
  run: (input: CallActionRouteInput<P>) => Promise<unknown>;
  /** Read-only reconciliation must not enqueue more work while the call is busy;
   *  a reconciliation that did apply a transition (`reconciled: true`) drains
   *  the session's deferred facts after release like any other action. */
  replayDeferred?: boolean;
  /**
   * Web hold/unhold (`hold_fast_web`, call-speed S7a.5): answer as soon as the
   * provider accepted the control's last command and its cursor is durable,
   * with `confirmedState` the staged state; the rest of the run (leg
   * projection, history, audit, lease release) and the usual maintenance
   * continue after the response. The phone's hold never comes here.
   */
  confirmControl?: "hold" | "unhold";
};

const CONFIRMED_STATE = { hold: "held", unhold: "talking" } as const;

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
      const confirm = options.confirmControl && latencyFlagsOf(deps).hold_fast_web ? options.confirmControl : null;
      const reportDeferred = (code = "event_replay_deferred") => {
        try { deps.logger?.({ level: "warn", scope: "call-action", sessionId: params.id, code }); }
        catch { /* Optional diagnostics cannot invalidate the completed action. */ }
      };

      // A customer hangup/answer can arrive while this action owns the call.
      // Once the action has completed and released ownership, recover its exact
      // queued facts without waiting for provider redelivery or the cron.
      const maintenance = (result: unknown) => {
        const applied = result && typeof result === "object" && "sessionId" in result && result.sessionId === params.id;
        const reconciled = applied && "reconciled" in result && result.reconciled === true;
        if (!applied || (options.replayDeferred === false && !reconciled)) return null;
        const terminationPending = "terminationPending" in result && result.terminationPending === true;
        return async () => {
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
        };
      };

      const input = { deps, actor: toCallActor(actor), sessionId: params.id, params, body, request };
      let result: unknown;
      if (confirm) {
        // The run keeps its lease and its async context; the response only
        // stops waiting for it. Never resolved, it is awaited whole as before.
        const eventId = randomUUID();
        let answerEarly: (settled: CommandSettled) => void = () => {};
        const work = observeCommandSettlement(settled => {
          if (settled.eventId === eventId && settled.last && settled.state === CONFIRMED_STATE[confirm]) answerEarly(settled);
        }, () => options.run({ ...input, eventId }));
        const first = await new Promise<{ early: CommandSettled } | { done: unknown }>((resolve, reject) => {
          answerEarly = settled => resolve({ early: settled });
          work.then(done => resolve({ done }), reject);
        });
        let scheduled = false;
        if ("early" in first) {
          try {
            // The tail's own maintenance follows it, as it follows a full run.
            after(withBackgroundRequestMetrics(async () => {
              let completed: unknown;
              // The operator already sees the hold; the staged entry stays owed for cron or the next event.
              try { completed = await work; } catch { reportDeferred("hold_tail_failed"); return; }
              await maintenance(completed)?.();
            }));
            scheduled = true;
          } catch { /* Nothing would keep the tail alive: answer after it, as before. */ }
          if (scheduled) {
            const { state, commands } = first.early;
            return Response.json({ ok: true, sessionId: params.id, state, commands, ignored: null, confirmedState: state });
          }
        }
        result = "done" in first ? first.done : await work;
      } else {
        result = await options.run(input);
      }

      const terminationPending = Boolean(result && typeof result === "object" && "sessionId" in result && result.sessionId === params.id &&
        "terminationPending" in result && result.terminationPending === true);
      const maintain = maintenance(result);
      if (maintain) {
        try { after(withBackgroundRequestMetrics(maintain)); }
        catch { reportDeferred(); }
      }

      const fields = result && typeof result === "object" ? result as Record<string, unknown> : {};
      // `hold_fast_web`: the server's state after the control, for the console to show at once.
      const confirmed = confirm && fields.sessionId === params.id && !fields.ignored && fields.state === CONFIRMED_STATE[confirm] ? { confirmedState: fields.state } : {};
      return Response.json({ ok: true, ...fields, ...confirmed }, { status: terminationPending ? 202 : 200 });
    } catch (error) {
      return telephonyErrorResponse(error, options.fallback);
    }
  }, { operation: callPerformanceOperation(request.url, request.method) });
}

/** `{ profileId, number }` transfer/consult target from a request body. */
export function readTransferTarget(body: Record<string, unknown>): { profileId: string | null; number: string | null } {
  const profileId = typeof body.profileId === "string" && body.profileId.trim() ? body.profileId.trim() : null;
  const number = typeof body.number === "string" && body.number.trim() ? body.number.trim() : null;
  return { profileId, number };
}
