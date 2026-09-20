import "server-only";

import type { AiDemoDeps } from "./orchestrator";

/**
 * The per-case, per-day attempt counter.
 *
 * Kept out of the gate itself so the rule stays testable without a database,
 * and so a failure here can never cost a call: if the count cannot be read the
 * caller is treated as having used none, and if it cannot be written the call
 * carries on. Losing a count is a smaller harm than dropping a call, and the
 * plate still has to match before anything opens.
 */

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function readVerificationAttempts(deps: AiDemoDeps, caseId: string, now: Date): Promise<number> {
  try {
    const { data, error } = await deps.admin
      .from("motorist_ai_verification_attempts")
      .select("attempts")
      .eq("organization_id", deps.organizationId)
      .eq("case_id", caseId)
      .eq("day", today(now))
      .maybeSingle();
    if (error || !data) return 0;
    return typeof data.attempts === "number" ? data.attempts : 0;
  } catch {
    // The comment above is the contract: an unreadable count reads as none.
    // The plate still has to match, so the worst this costs is that somebody
    // gets their three tries back during an outage.
    return 0;
  }
}

export async function recordVerificationAttempts(
  deps: AiDemoDeps,
  input: { caseId: string; attempts: number; verified: boolean; now: Date },
): Promise<void> {
  try {
    // Two calls about one case would otherwise race and the slower writer would
    // hand tries back. Whoever writes last writes the larger number; a counter
    // that only ever climbs cannot be reset by losing a race.
    const stored = await readVerificationAttempts(deps, input.caseId, input.now);
    const attempts = Math.max(stored, input.attempts);
    await deps.admin
      .from("motorist_ai_verification_attempts")
      .upsert(
        {
          organization_id: deps.organizationId,
          case_id: input.caseId,
          day: today(input.now),
          attempts,
          ...(input.verified ? { succeeded_at: input.now.toISOString() } : {}),
        },
        { onConflict: "case_id,day" },
      );
  } catch {
    // See the note above: a lost count never ends a call.
  }
}
