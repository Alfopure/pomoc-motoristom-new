import type { TelephonyEvent } from "../state/types";
import { adoptLeg, loadAttempt, markLegGone, patchAttempt, transitionAttempt, type AiDemoAttempt } from "./attempts";
import { AI_DEMO_LIMITS } from "./config";
import type { AiDemoLeg } from "./flag";
import { parseAiDemoClientState } from "./identity";
import { dialMobileLeg, endAttempt, requestEnding, runGreetingAndFinish, type AiDemoDeps } from "./orchestrator";

/**
 * Telnyx events for a demo leg.
 *
 * Reached from `processTelnyxEvent` after the ledger claim and before session
 * correlation, and only for a leg whose `client_state` carries our own
 * `ai_demo:` intent. The human call path never sees this module; a deployment
 * with the demo off never loads it.
 *
 * Everything is a conditional transition, so the interesting orderings are all
 * no-ops rather than bugs: `call.bridged` can arrive before `call.answered`,
 * `call.initiated` can arrive after a hangup, and any event can arrive twice.
 *
 * Replay is the one case that needs care. A `call.answered` the cron re-drives
 * minutes later must not trigger a greeting into a call that is long over, so
 * a replayed answer ends the attempt instead of advancing it.
 */

export type AiDemoEventOutcome = {
  handled: true;
  attemptId: string;
  action: string;
  state: string;
} | { handled: false; reason: string };

function ignored(reason: string): AiDemoEventOutcome {
  return { handled: false, reason };
}

/** `true` when this event belongs to a demo leg; cheap enough for the hot path. */
export function isAiDemoEvent(event: TelephonyEvent): boolean {
  return parseAiDemoClientState(event.rawClientState) !== null;
}

export async function handleAiDemoTelnyxEvent(deps: AiDemoDeps, event: TelephonyEvent): Promise<AiDemoEventOutcome> {
  const parsed = parseAiDemoClientState(event.rawClientState);
  if (!parsed) return ignored("not_ai_demo");

  const attempt = await loadAttempt(deps.admin, deps.organizationId, parsed.attemptId);
  if (!attempt) return ignored("unknown_attempt");

  const now = deps.now ? deps.now() : new Date();
  const replay = deps.ledgerReplay !== undefined;

  // Provider ids are facts regardless of state, and after a request timeout the
  // webhook may be the only place a `call_control_id` ever appears.
  await adoptLeg(deps.admin, attempt.id, parsed.leg, event, timestampFor(parsed.leg, event.type, now));

  switch (event.type) {
    case "call.initiated":
      return done(attempt, "adopted", attempt.state);

    case "call.answered":
      return handleAnswered(deps, attempt, parsed.leg, now, replay);

    case "call.bridged":
      return handleBridged(deps, attempt, now, replay);

    case "call.hangup":
      return handleHangup(deps, attempt, parsed.leg, event, now);

    default:
      // Playback, speak, cost and the rest are bookkeeping for this feature.
      return done(attempt, "bookkeeping", attempt.state);
  }
}

function timestampFor(leg: AiDemoLeg, type: string, now: Date): Record<string, string> {
  const iso = now.toISOString();
  if (type === "call.initiated") return leg === "sip" ? { sip_initiated_at: iso } : { mobile_initiated_at: iso };
  if (type === "call.answered") return leg === "sip" ? { sip_answered_at: iso } : { mobile_answered_at: iso };
  return {};
}

function done(attempt: AiDemoAttempt, action: string, state: string): AiDemoEventOutcome {
  return { handled: true, attemptId: attempt.id, action, state };
}

/**
 * The AI leg answered → dial the person. The person answered → greet.
 *
 * The SIP answer is the single trigger for the outbound dial. Dialling earlier
 * (straight after `accept`) would save a second of ring time that nobody is
 * listening to, at the price of a second code path towards a billable call.
 */
async function handleAnswered(deps: AiDemoDeps, attempt: AiDemoAttempt, leg: AiDemoLeg, now: Date, replay: boolean): Promise<AiDemoEventOutcome> {
  if (leg === "sip") {
    if (replay) {
      // A replayed answer says nothing about now. Ending is the safe reading.
      const ended = await requestEnding(deps, attempt.id, "replayed_answer", "sip_answer_lost");
      if (ended) await endAttempt(deps, attempt.id, AI_DEMO_LIMITS.cleanupBudgetWebhookMs, "deferred");
      return done(attempt, "replayed_sip_answer", "ending");
    }
    const moved = await transitionAttempt(deps.admin, attempt.id, ["ai_offered", "ai_accepted"], {
      state: "mobile_dialing",
      sip_answered_at: attempt.sip_answered_at ?? now.toISOString(),
      mobile_dialed_at: now.toISOString(),
    });
    if (!moved) return done(attempt, "sip_answer_noop", attempt.state);
    await dialMobileLeg(deps, moved);
    return done(attempt, "mobile_dialed", "mobile_dialing");
  }

  if (replay) {
    const moved = await transitionAttempt(deps.admin, attempt.id, ["mobile_dialing", "bridged"], {
      state: "talking",
      greeting_status: "skipped_replay",
      talking_at: now.toISOString(),
    });
    return done(attempt, "replayed_mobile_answer", moved?.state ?? attempt.state);
  }
  return bridge(deps, attempt, now, "mobile_answered");
}

/** `bridge_on_answer` can emit `call.bridged` before `call.answered`; either one starts the greeting. */
async function handleBridged(deps: AiDemoDeps, attempt: AiDemoAttempt, now: Date, replay: boolean): Promise<AiDemoEventOutcome> {
  if (replay) return done(attempt, "replayed_bridge", attempt.state);
  return bridge(deps, attempt, now, "bridged");
}

async function bridge(deps: AiDemoDeps, attempt: AiDemoAttempt, now: Date, action: string): Promise<AiDemoEventOutcome> {
  const moved = await transitionAttempt(deps.admin, attempt.id, ["mobile_dialing"], {
    state: "bridged",
    bridged_at: now.toISOString(),
    mobile_answered_at: attempt.mobile_answered_at ?? now.toISOString(),
    greeting_status: "requested",
  });
  if (!moved) return done(attempt, `${action}_noop`, attempt.state);

  // After the response: the greeting needs a WebSocket round trip and Telnyx
  // wants its 200 inside ten seconds. The conditional transition above is what
  // guarantees this runs exactly once.
  const work = () => runGreetingAndFinish(deps, moved.id);
  if (deps.deferMaintenance) deps.deferMaintenance(work);
  else await work();
  return done(attempt, action, "bridged");
}

/**
 * One leg is gone, so the demo is over.
 *
 * Which leg went first is the difference between "the customer hung up", "the
 * AI session dropped" and "the time limit fired", and all three are recorded
 * before the row closes: it is the only evidence available afterwards.
 */
async function handleHangup(deps: AiDemoDeps, attempt: AiDemoAttempt, leg: AiDemoLeg, event: TelephonyEvent, now: Date): Promise<AiDemoEventOutcome> {
  const cause = event.hangupCause ?? event.sipHangupCause ?? "unknown";
  await markLegGone(deps.admin, attempt.id, leg, cause, now);
  await patchAttempt(deps.admin, attempt.id, { hangup_source: event.hangupSource ?? attempt.hangup_source });

  if (attempt.state === "ended" || attempt.state === "failed") return done(attempt, "hangup_after_terminal", attempt.state);

  const { endReason, errorCode } = describeHangup(attempt.state, leg, cause);
  await requestEnding(deps, attempt.id, endReason, errorCode);
  const result = await endAttempt(deps, attempt.id, AI_DEMO_LIMITS.cleanupBudgetWebhookMs, "deferred");
  return done(attempt, "hangup", result.state);
}

/**
 * Turns a hangup into a reason and, when it is a real failure, an error code.
 *
 * A customer hanging up mid-conversation is a completed demo, not an error. The
 * AI leg dying before the bridge is an error, because nobody got to hear
 * anything.
 */
export function describeHangup(state: string, leg: AiDemoLeg, cause: string): { endReason: string; errorCode: string | null } {
  if (leg === "sip") {
    if (state === "talking" || state === "bridged") return { endReason: cause, errorCode: null };
    if (state === "sip_dialing") {
      if (cause === "timeout" || cause === "no_answer") return { endReason: cause, errorCode: "sip_no_answer" };
      return { endReason: cause, errorCode: "sip_rejected" };
    }
    return { endReason: cause, errorCode: "sip_ended_early" };
  }
  if (state === "mobile_dialing") {
    // Nobody answered, or the phone refused: an outcome, not a fault.
    return { endReason: `mobile_${cause}`, errorCode: null };
  }
  return { endReason: `mobile_${cause}`, errorCode: null };
}
