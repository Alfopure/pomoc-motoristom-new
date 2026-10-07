import type { ActiveCallsPayload } from "./active-calls-model";

export type HangupSnapshotScope = {
  sessionId: string;
  organizationId: string;
  actorProfileId: string;
  /** Last read already started when the operator clicked hangup. */
  afterSnapshotRequest: number;
};

/**
 * A successful read started after the click can retire this session's UI.
 * A retained snapshot, a local SDK BYE or an older in-flight read cannot.
 * Absence means the session left the actor's active view; it is not evidence
 * that every provider leg has ended (wrap-up is excluded from that view).
 */
export function hangupSnapshotConfirmsEnd(
  pending: HangupSnapshotScope,
  snapshot: ActiveCallsPayload,
  snapshotRequest: number,
): boolean {
  if (snapshotRequest <= pending.afterSnapshotRequest || !snapshot.configured ||
    !pending.organizationId || !pending.actorProfileId ||
    snapshot.organizationId !== pending.organizationId || snapshot.actorProfileId !== pending.actorProfileId ||
    !Array.isArray(snapshot.calls) || !Array.isArray(snapshot.waiting)) return false;
  const calls = [...snapshot.calls, ...snapshot.waiting].filter((call) => call.sessionId === pending.sessionId);
  return calls.every((call) => ["ended", "missed", "failed"].includes(call.state));
}
