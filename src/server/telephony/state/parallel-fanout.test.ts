import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { TelnyxCommandError } from "../telnyx/client";
import { advanceRingStep } from "../routing/ring-plan";

afterEach(() => { vi.unstubAllEnvs(); });

function harness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
}

const offered = (h: TelephonyHarness, sessionId: string) =>
  h.attempts(sessionId).filter((attempt) => attempt.result === "offered");

/** Records how many dials were in flight at the same moment. */
function watchDials(h: TelephonyHarness) {
  const state = { inFlight: 0, peak: 0 };
  const client = h.telnyx.client as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const dial = client.dial.bind(h.telnyx.client);
  client.dial = async (input: unknown) => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    // Yielding here means a caller that awaits each dial in turn can never
    // observe a peak above one.
    try {
      await Promise.resolve();
      return await dial(input);
    } finally {
      state.inFlight -= 1;
    }
  };
  return state;
}

describe("ring fan-out", () => {
  it("starts every operator's phone ringing together", async () => {
    const h = harness();
    const seen = watchDials(h);

    const call = await h.inbound({ to: NUMBERS.allianz });

    // Three operators share step 0. The third used to wait out the first two
    // in full — their database round trips as well as their provider calls.
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(seen.peak).toBe(3);
    expect(offered(h, call.sessionId)).toHaveLength(3);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("makes the offer tokens durable before any leg exists, in one write", async () => {
    const h = harness();
    const sessionWritesAtDial: number[] = [];
    const client = h.telnyx.client as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const dial = client.dial.bind(h.telnyx.client);
    const sessionWrites = () =>
      h.db.log.filter((row) => row.table === "motorist_call_sessions" && row.operation === "update").length;
    client.dial = async (input: unknown) => {
      sessionWritesAtDial.push(sessionWrites());
      return dial(input);
    };

    const call = await h.inbound({ to: NUMBERS.allianz });

    // A replayed webhook has to recognise its own offer, so the tokens are
    // written before a leg can exist. The three members are claimed, then
    // persisted together, then dialled: no session write falls between the
    // dials, where three fenced compare-and-sets would be racing on one row.
    expect(sessionWritesAtDial).toHaveLength(3);
    expect(sessionWritesAtDial[0]).toBeGreaterThan(0);
    expect(new Set(sessionWritesAtDial).size).toBe(1);
    expect(offered(h, call.sessionId)).toHaveLength(3);
  });

  it("rings the rest of the group when one operator's dial is refused", async () => {
    const h = harness();
    h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rejected", status: 422, detail: "dial refused" }));

    const call = await h.inbound({ to: NUMBERS.allianz });

    // One member's rejection is that member's problem, not the group's.
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(h.attempts(call.sessionId).find((attempt) => attempt.profile_id === PROFILES.o1)?.result).toBe("failed");
    expect(offered(h, call.sessionId)).toHaveLength(2);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("skips a member already offered this step and dials the others", async () => {
    const h = harness();
    // What a replay looks like from below: the partial unique index refuses
    // the second offer for one member.
    h.db.failNext("motorist_ring_attempts", "insert", { code: "23505", message: "duplicate key" } as never);

    const call = await h.inbound({ to: NUMBERS.allianz });

    // A single multi-row insert would have taken the whole step down with it.
    expect(h.telnyx.of("dial")).toHaveLength(2);
    expect(offered(h, call.sessionId)).toHaveLength(2);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("refuses a second advance of the step it has already rung", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.telnyx.of("dial")).toHaveLength(3);

    // The group goes out under a compare-and-set on `current_step`. An
    // invocation arriving with the old expectation has to lose it, or three
    // more phones ring. (`transitions.test.ts` drives the whole race; this
    // pins the guard on the parallel path.)
    const step = Number(h.session(call.sessionId).current_step);
    expect(await advanceRingStep(h.admin, call.sessionId, step - 1)).toBe(false);
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });

  it("dials each member once, however the group is retried", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });

    // The provider journal is what makes this true: a replayed command is
    // answered from the recorded outcome, not sent again.
    const perMember = new Map<string, number>();
    for (const dial of h.telnyx.of("dial")) {
      const to = String(dial.params.to);
      perMember.set(to, (perMember.get(to) ?? 0) + 1);
    }
    expect([...perMember.values()].every((count) => count === 1)).toBe(true);
    expect(offered(h, call.sessionId)).toHaveLength(3);
  });

  it("keeps one member's provider failure off the others", async () => {
    const h = harness();
    // A rate limit is not a refusal: the member is failed, the group is not.
    h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rate_limited", status: 429, detail: "slow down" }));

    const call = await h.inbound({ to: NUMBERS.allianz });

    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(offered(h, call.sessionId).length).toBeGreaterThanOrEqual(2);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("asks the journal about a dial only when there is something to replay", async () => {
    const h = harness();
    await h.inbound({ to: NUMBERS.allianz });

    // A first attempt carries a continuation, so a lookup keyed on its mere
    // existence cost one round trip per operator rung and could never find
    // anything.
    const lookups = h.db.log.filter((row) => row.table === "motorist_provider_command_lookup_v2").length;
    expect(lookups).toBe(0);
  });
});
