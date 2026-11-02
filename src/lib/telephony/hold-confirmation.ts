import type { ActiveCallsPayload } from "./active-calls-model";

/**
 * A hold or unhold the server confirmed (`confirmedState`, call-speed S7a.1,
 * `hold_fast_web`). The console shows it at once instead of waiting for a
 * snapshot pass that may have started before the change.
 */
export type HoldConfirmation = {
  sessionId: string;
  action: "hold" | "unhold";
  state: "held" | "talking";
  /** Browser clock (ms) when the confirmation arrived. */
  at: number;
};

/**
 * Longer than the slowest healthy poll (3 s), so a snapshot taken before the
 * change cannot flip the bar back; short enough that a later change made
 * elsewhere (another tab, the phone) wins within one more poll.
 */
export const HOLD_CONFIRMATION_TTL_MS = 4_000;

export function holdConfirmation(action: string, sessionId: string, body: { confirmedState?: unknown; ignored?: unknown } | null | undefined, at: number): HoldConfirmation | null {
  if (action !== "hold" && action !== "unhold") return null;
  const state = action === "hold" ? "held" : "talking";
  return body?.confirmedState === state && !body.ignored ? { sessionId, action, state, at } : null;
}

/**
 * The snapshot with the confirmed state applied while it still shows the call
 * as it was before (the earlier state, or the control still pending). Once a
 * snapshot shows the confirmed state, anything else, or the TTL has passed,
 * the confirmation is spent and the snapshot is returned as read.
 */
export function applyHoldConfirmation(snapshot: ActiveCallsPayload, confirmation: HoldConfirmation | null, now: number): { snapshot: ActiveCallsPayload; keep: boolean } {
  if (!confirmation || now - confirmation.at > HOLD_CONFIRMATION_TTL_MS || now < confirmation.at) return { snapshot, keep: false };
  const call = snapshot.calls.find(candidate => candidate.sessionId === confirmation.sessionId);
  const before = confirmation.state === "held" ? "talking" : "held";
  const predates = call && (call.controlPending?.action === confirmation.action || call.state === before && !call.controlPending);
  if (!call || !predates) return { snapshot, keep: false };
  const holdStartedAt = confirmation.state === "held" ? call.holdStartedAt ?? new Date(confirmation.at).toISOString() : null;
  return {
    snapshot: { ...snapshot, calls: snapshot.calls.map(candidate => candidate === call ? { ...call, state: confirmation.state, controlPending: null, holdStartedAt } : candidate) },
    keep: true,
  };
}
