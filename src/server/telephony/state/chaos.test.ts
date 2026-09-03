import { describe, expect, it } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

/**
 * Chaos coverage (design §Phase 5): Telnyx guarantees delivery, not order, and
 * retries anything it did not get a 2xx for. Individual reorderings are already
 * pinned in `transitions.test.ts`; this file asserts the property behind them —
 * for a call that is already talking, *any* order of the teardown events, and
 * any amount of duplicate delivery, has to leave the same rows behind.
 *
 * The invariant is deliberately about the end state, not the commands: which
 * `hangup` the app sends depends on who dropped first, but the session, the
 * `motorist_calls` row and every operator's presence must not.
 */

type Snapshot = {
  state: unknown;
  endReason: unknown;
  answeredBy: unknown;
  calls: number;
  callStatus: unknown;
  callEndReason: unknown;
  openLegs: number;
  presence: Record<string, unknown>;
};

async function talkingCall(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const legs = {
    o1: String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id),
    o2: String(h.legFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id),
    o5: String(h.legFor(call.sessionId, PROFILES.o5)!.telnyx_call_control_id),
  };
  await h.legEvent(legs.o1, "call.answered");
  expect(h.session(call.sessionId).state).toBe("talking");
  return { ...call, ...legs };
}

function snapshot(h: TelephonyHarness, sessionId: string): Snapshot {
  const session = h.session(sessionId);
  const call = h.call(sessionId);
  return {
    state: session.state,
    endReason: session.end_reason,
    answeredBy: session.answered_by_profile_id,
    calls: h.rows("motorist_calls").filter((row) => row.session_id === sessionId).length,
    callStatus: call?.status ?? null,
    callEndReason: call?.end_reason ?? null,
    openLegs: h.legs(sessionId).filter((leg) => !leg.ended_at).length,
    presence: Object.fromEntries(Object.values(PROFILES).map((profile) => [profile, h.presence(profile)?.status ?? null])),
  };
}

/** Every ordering of `items`, so the test states the property instead of sampling it. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

type Teardown = { key: string; leg: (call: Awaited<ReturnType<typeof talkingCall>>) => string; cause: string; source?: string };

const TEARDOWN: Teardown[] = [
  { key: "loser-o2", leg: (call) => call.o2, cause: "originator_cancel" },
  { key: "loser-o5", leg: (call) => call.o5, cause: "originator_cancel" },
  { key: "customer", leg: (call) => call.callControlId, cause: "normal_clearing", source: "caller" },
  { key: "operator", leg: (call) => call.o1, cause: "normal_clearing", source: "callee" },
];

describe("webhook chaos", () => {
  it("ends the same way for every order of the teardown events", async () => {
    // The caller drops first in all of them, so the end reason is comparable;
    // what varies is when the losing legs and the operator's own leg report in.
    const orders = permutations(TEARDOWN).filter((order) => order.findIndex((step) => step.key === "customer") < order.findIndex((step) => step.key === "operator"));
    expect(orders).toHaveLength(12);

    let reference: Snapshot | null = null;
    for (const order of orders) {
      const h = createTelephonyHarness();
      const call = await talkingCall(h);
      for (const [index, step] of order.entries()) {
        await h.legEvent(step.leg(call), "call.hangup", { hangup_cause: step.cause, ...(step.source ? { hangup_source: step.source } : {}) }, `evt-${step.key}-${index}`);
      }

      const result = snapshot(h, call.sessionId);
      expect(result, order.map((step) => step.key).join(" → ")).toMatchObject({
        state: "ended",
        calls: 1,
        callStatus: "ended",
        openLegs: 0,
      });
      reference ??= result;
      expect(result, order.map((step) => step.key).join(" → ")).toEqual(reference);
    }
  });

  it("is unchanged when Telnyx redelivers every event of the call", async () => {
    const clean = createTelephonyHarness();
    const cleanCall = await talkingCall(clean);
    for (const [index, step] of TEARDOWN.entries()) {
      await clean.legEvent(step.leg(cleanCall), "call.hangup", { hangup_cause: step.cause, ...(step.source ? { hangup_source: step.source } : {}) }, `evt-${step.key}-${index}`);
    }
    const expected = snapshot(clean, cleanCall.sessionId);

    // Same call, but every event is delivered twice with the same `event_id`,
    // which is what a webhook retry after a slow 200 looks like.
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const legs = {
      o1: String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id),
      o2: String(h.legFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id),
      o5: String(h.legFor(call.sessionId, PROFILES.o5)!.telnyx_call_control_id),
    };
    const replay = await h.legEvent(legs.o1, "call.answered", {}, "evt-answer");
    expect(replay.outcome).toBe("processed");
    expect((await h.legEvent(legs.o1, "call.answered", {}, "evt-answer")).outcome).toBe("duplicate");

    const resolve = { "loser-o2": legs.o2, "loser-o5": legs.o5, customer: call.callControlId, operator: legs.o1 } as Record<string, string>;
    for (const [index, step] of TEARDOWN.entries()) {
      const payload = { hangup_cause: step.cause, ...(step.source ? { hangup_source: step.source } : {}) };
      const first = await h.legEvent(resolve[step.key], "call.hangup", payload, `evt-${step.key}-${index}`);
      expect(first.outcome).toBe("processed");
      expect((await h.legEvent(resolve[step.key], "call.hangup", payload, `evt-${step.key}-${index}`)).outcome).toBe("duplicate");
    }

    expect(snapshot(h, call.sessionId)).toEqual(expected);
  });

  it("does not resurrect an ended call when a losing operator's answer arrives late", async () => {
    const h = createTelephonyHarness();
    const call = await talkingCall(h);
    for (const [index, step] of TEARDOWN.entries()) {
      await h.legEvent(step.leg(call), "call.hangup", { hangup_cause: step.cause, ...(step.source ? { hangup_source: step.source } : {}) }, `evt-${step.key}-${index}`);
    }
    const ended = snapshot(h, call.sessionId);

    // The loser picked up a fraction of a second before the app hung it up; the
    // event arrives after everything is over.
    await h.legEvent(call.o2, "call.answered", {}, "evt-late-answer");

    expect(snapshot(h, call.sessionId)).toEqual(ended);
    expect(h.telnyx.of("bridge").length).toBeLessThanOrEqual(1);
  });
});
