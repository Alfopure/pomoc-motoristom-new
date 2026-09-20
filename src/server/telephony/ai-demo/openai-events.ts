import { parseLiveIncoming } from "@/lib/integrations/ai/openai-live";

import { findPendingForIncoming, transitionAttempt } from "./attempts";
import { AI_DEMO_LIMITS, AI_DEMO_REJECT_UNMATCHED, AI_DEMO_STRICT_TO } from "./config";
import { acceptSession, type AiDemoDeps } from "./orchestrator";

/**
 * `live.transport.incoming`: OpenAI has an inbound SIP session waiting for a
 * decision.
 *
 * The decision has to be made here and now — the provider retries only when it
 * does not get a 2xx, and the caller's phone has not started ringing yet, so
 * this is the cheapest place in the whole flow to spend time.
 *
 * Authorisation is *not* the signature and *not* the SIP headers. A valid
 * signature proves the event came from OpenAI; it does not prove the INVITE
 * behind it was ours. The authority is a row this application created when an
 * admin pressed the button. An event that matches no such row is acknowledged
 * and dropped: rejecting it with a SIP 603 would mean answering for somebody
 * else's call.
 */

export type OpenAIEventResult =
  | { outcome: "accepted" | "already_running"; attemptId: string }
  | { outcome: "ignored"; reason: string }
  | { outcome: "failed"; attemptId: string; code: string };

export async function handleOpenAIIncoming(deps: AiDemoDeps, payload: unknown): Promise<OpenAIEventResult> {
  const incoming = parseLiveIncoming(payload);
  if (!incoming) return { outcome: "ignored", reason: "unsupported_event" };

  const now = deps.now ? deps.now() : new Date();
  const match = await findPendingForIncoming(deps.admin, deps.organizationId, {
    now,
    sessionId: incoming.sessionId,
    fromHeader: incoming.fromHeader,
  });

  if ("ignored" in match) {
    deps.logger?.({ scope: "ai-demo", message: "openai incoming ignored", reason: match.ignored, sessionId: incoming.sessionId });
    if (AI_DEMO_REJECT_UNMATCHED) {
      // Deliberately unreachable until the project is confirmed to be exclusive
      // to this deployment; see the open questions in the plan.
      return { outcome: "ignored", reason: match.ignored };
    }
    return { outcome: "ignored", reason: match.ignored };
  }

  const attempt = match.match;

  if (match.reason === "same_session") {
    // A redelivered webhook. The first accept won; saying so is the whole point
    // of treating `decision_already_made` as success.
    if (attempt.state !== "ai_offered") return { outcome: "already_running", attemptId: attempt.id };
    const retryDue = attempt.accept_started_at === null || now.getTime() - Date.parse(attempt.accept_started_at) >= AI_DEMO_LIMITS.acceptRetryAfterMs;
    if (!retryDue) return { outcome: "already_running", attemptId: attempt.id };
    const claimed = await transitionAttempt(deps.admin, attempt.id, ["ai_offered"], { accept_started_at: now.toISOString() });
    if (!claimed) return { outcome: "already_running", attemptId: attempt.id };
    const result = await acceptSession(deps, claimed, incoming.sessionId);
    return result.accepted ? { outcome: "accepted", attemptId: attempt.id } : { outcome: "failed", attemptId: attempt.id, code: result.code ?? "accept_failed" };
  }

  const offered = await transitionAttempt(deps.admin, attempt.id, ["sip_dialing"], {
    state: "ai_offered",
    ai_offered_at: now.toISOString(),
    accept_started_at: now.toISOString(),
    openai_session_id: incoming.sessionId,
    metadata: {
      ...(attempt.metadata as Record<string, unknown>),
      openai_from_match: incoming.fromHeader !== null,
      // The `To` shape on OpenAI's side is unverified, so it is recorded and
      // compared in the logs rather than used as a gate.
      openai_to_match: AI_DEMO_STRICT_TO ? incoming.toHeader : null,
    },
  });
  if (!offered) return { outcome: "ignored", reason: "state_conflict" };

  const result = await acceptSession(deps, offered, incoming.sessionId);
  return result.accepted ? { outcome: "accepted", attemptId: attempt.id } : { outcome: "failed", attemptId: attempt.id, code: result.code ?? "accept_failed" };
}
