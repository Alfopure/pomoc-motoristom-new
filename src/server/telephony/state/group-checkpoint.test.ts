import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function harness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
  return createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
}

const sessionWrites = (h: TelephonyHarness, from: number) =>
  h.db.log.slice(from).filter((row) => row.table === "motorist_call_sessions" && row.operation === "update").length;

/** The answer that ends a ring: bridge, stop the audio, hang the losers up. */
async function answerWinner(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  const from = h.db.log.length;
  await h.legEvent(winner, "call.answered");
  expect(h.session(call.sessionId).state).toBe("talking");
  return { call, winner, from };
}

describe("one checkpoint for an overlapping run", () => {
  it("records the whole run in a single write", async () => {
    const h = harness();
    const { call, from } = await answerWinner(h);

    // The run is the best-effort teardown behind the bridge: two losing legs
    // hung up and the waiting audio stopped. Each used to cost its own fenced
    // compare-and-set on the session row, to record facts the provider had
    // already accepted.
    const overlapping = h.telnyx.of("hangup").length + h.telnyx.of("playbackStop").length + h.telnyx.of("gatherStop").length;
    expect(overlapping).toBeGreaterThan(1);
    // Measured: 9 writes before, 7 after. One of headroom, because the
    // throttled incident read fires or not depending on wall-clock.
    expect(sessionWrites(h, from)).toBeLessThanOrEqual(8);
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("replays with no provider calls when the write never happened", async () => {
    const h = harness();
    const { call, winner } = await answerWinner(h);
    const before = h.telnyx.calls.length;

    // What a crash between the run and its checkpoint leaves: the commands
    // happened, the record of them did not. The replay has to be free.
    const session = h.db.storage("motorist_call_sessions").find((row) => row.id === call.sessionId)!;
    const entries = (session.pending_effects as { entries?: { completedCommands?: string[] }[] } | null)?.entries ?? [];
    for (const entry of entries) entry.completedCommands = [];

    await h.legEvent(winner, "call.answered", {}, "replayed-answer");

    // `prepare_v2` answers every replayed command from its recorded outcome,
    // so nothing reaches the provider: no second hangup for a losing leg, no
    // second stop for audio that already stopped. This is the invariant the
    // banking rests on, which is why it is asserted rather than assumed.
    expect(h.telnyx.calls.length).toBe(before);
    expect(h.session(call.sessionId).state).toBe("talking");
  });

});
