import type { CallActor } from "./call-actions";
import { isUuid } from "@/lib/telephony/uuid";
import { CallActionError } from "./service-errors";
import { runSessionEvent, type SessionRunnerDeps } from "./session-runner";
import { TERMINAL_STATES, type SessionRow, type TelephonyEvent } from "./state/types";

/** Reuse the webhook pipeline so presence, history and remaining legs converge together. */
export function reconciledHangupEvent(callControlId: string, now: Date, known: boolean): TelephonyEvent {
  return {
    kind: "telnyx", id: `reconcile:${callControlId}:${Math.floor(now.getTime() / 60_000)}`,
    type: "call.hangup", occurredAt: now.toISOString(), callControlId,
    callLegId: null, callSessionId: null, connectionId: null, clientState: null,
    rawClientState: null, from: null, to: null, direction: null, state: null,
    hangupCause: "reconciled", hangupSource: null, sipHangupCause: null,
    digits: null, status: null, conferenceId: null, customHeaders: [],
    payload: { reconciled: true, known },
  };
}

export type CallReconciliationResult = {
  sessionId: string;
  state: SessionRow["state"];
  reconciled: boolean;
  reason?: "alive" | "provider_unknown" | "already_terminal" | "already_ended" | "ignored";
};

/**
 * A browser losing its leg is a hint, never authority to end a call. Verify
 * that exact actor-owned leg with Telnyx before replaying its missing hangup.
 * Each request reads one provider leg, without waiting for the cron idle gate.
 */
export async function reconcileBrowserCall(
  deps: SessionRunnerDeps,
  actor: CallActor,
  sessionId: string,
  callControlId: unknown,
): Promise<CallReconciliationResult> {
  if (!isUuid(sessionId)) throw new CallActionError("Hovor sa nenašiel.", 404, "not_found");
  if (typeof callControlId !== "string" || !callControlId.trim() || callControlId.length > 2048) {
    throw new CallActionError("Chýba identifikátor telefónneho spojenia.", 400, "invalid_call_control_id");
  }
  const [sessionResult, legResult] = await Promise.all([
    deps.admin.from("motorist_call_sessions").select("id, state")
      .eq("organization_id", deps.organizationId).eq("id", sessionId).maybeSingle(),
    deps.admin.from("motorist_call_legs").select("id, ended_at")
      .eq("organization_id", deps.organizationId).eq("session_id", sessionId)
      .eq("telnyx_call_control_id", callControlId).eq("profile_id", actor.profileId)
      .in("role", ["operator", "consult", "supervisor"]).maybeSingle(),
  ]);
  if (sessionResult.error || legResult.error) throw new CallActionError("Stav hovoru sa nepodarilo overiť.", 500);
  if (!sessionResult.data || !legResult.data) throw new CallActionError("Telefónne spojenie sa nenašlo.", 404, "leg_not_found");
  const result = { sessionId, state: sessionResult.data.state, reconciled: false };
  if (TERMINAL_STATES.has(result.state)) return { ...result, reason: "already_terminal" };
  if (legResult.data.ended_at) return { ...result, reason: "already_ended" };
  if (!deps.telnyx) throw new CallActionError("Telefónia nie je nakonfigurovaná.", 503, "not_configured");

  const provider = await deps.telnyx.retrieveCall(callControlId);
  if (provider.alive) return { ...result, reason: "alive" };
  if (!provider.known || provider.raw?.is_alive !== false) return { ...result, reason: "provider_unknown" };

  const run = await runSessionEvent(deps, sessionId, reconciledHangupEvent(callControlId, (deps.now ?? (() => new Date()))(), true));
  if (run.outcome === "applied" && run.apply.failed) {
    throw new CallActionError("Stav hovoru sa nepodarilo obnoviť.", 502, "command_failed");
  }
  return { sessionId, state: run.session.state, reconciled: run.outcome === "applied", ...(run.outcome === "ignored" ? { reason: "ignored" as const } : {}) };
}
