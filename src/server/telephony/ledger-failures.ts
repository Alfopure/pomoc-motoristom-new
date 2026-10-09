import type { TelephonyAlertEvidence } from "./alert-evidence";

export type LedgerFailureKind = "call_ended" | "database_timeout" | "processing_failure";

/** Classify the stored processor error; never send its arbitrary text in mail. */
export function ledgerFailureKind(error: unknown): LedgerFailureKind | null {
  if (typeof error !== "string" || !error) return null;
  if (/^(?:TelnyxCommandError:\s*)?90018\(422\):/.test(error)) return "call_ended";
  if (/\b(?:owned database request|un-owned read) exceeded \d+ ms\b/.test(error)) return "database_timeout";
  return "processing_failure";
}

/**
 * A refused command on a fully ended call needs no incident email. A caller
 * hangup alone never dismisses a timeout, lost correlation or unfinished work.
 * Missing, ambiguous or bounded-out evidence keeps the original failure visible.
 */
export function resolvedCallEndFailureIds(evidence: TelephonyAlertEvidence, checkedAt: string): Set<string> {
  const resolved = new Set<string>();
  if (evidence.errors.length || evidence.truncated || evidence.missingSessionIds.length) return resolved;
  const now = Date.parse(checkedAt);
  const ended = (at: string | null) => at !== null && Number.isFinite(Date.parse(at)) && Date.parse(at) <= now;
  for (const event of evidence.events) {
    if (event.failureKind !== "call_ended" || event.sessionIds.length !== 1) continue;
    const call = evidence.calls.find(call => call.sessionId === event.sessionIds[0]);
    if (!call || call.state !== "ended" || !ended(call.endedAt) || call.pendingWork !== false || call.pendingConnection) continue;
    if (!call.legs.some(leg => leg.role === "customer") || !call.legs.every(leg => leg.state === "ended" && ended(leg.endedAt))) continue;
    resolved.add(event.eventId);
  }
  return resolved;
}
