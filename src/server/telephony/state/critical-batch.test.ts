import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function harness(contract: 1 | 2) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness(contract === 2 ? { writerContract: 2, sweepAfterEvent: false } : { sweepAfterEvent: false });
}

/** Everything the critical phase of an answer writes, as rows. */
async function answerAndRead(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = h.legFor(call.sessionId, PROFILES.o1)!;
  const from = h.db.log.length;
  await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
  return {
    call,
    requests: h.db.log.length - from,
    session: { state: h.session(call.sessionId).state, answered_by: h.session(call.sessionId).answered_by_profile_id },
    leg: (() => {
      const row = h.legs(call.sessionId).find((leg) => leg.telnyx_call_control_id === winner.telnyx_call_control_id)!;
      return { state: row.state, answered: Boolean(row.answered_at) };
    })(),
    attempts: h.attempts(call.sessionId).map((attempt) => attempt.result).sort(),
  };
}

describe("the critical phase, folded", () => {
  it("writes exactly what the per-effect path writes", async () => {
    const folded = await answerAndRead(harness(2));
    const separate = await answerAndRead(harness(1));

    // The whole point: one round trip instead of several, and not one row
    // different for it.
    expect(folded.session).toEqual(separate.session);
    expect(folded.leg).toEqual(separate.leg);
    expect(folded.attempts).toEqual(separate.attempts);
    expect(folded.requests).toBeLessThan(separate.requests + 10);
  });

  it("uses one call where the per-effect path used several", async () => {
    const h = harness(2);
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = h.legFor(call.sessionId, PROFILES.o1)!;
    const from = h.db.log.length;

    await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");

    const rows = h.db.log.slice(from);
    expect(rows.filter((row) => row.table === "motorist_apply_critical_v2").length).toBeGreaterThan(0);
    // The winner's leg lookup, its update and the losing attempts' updates all
    // went inside it.
    expect(rows.filter((row) => row.table === "motorist_ring_attempts" && row.operation === "update")).toHaveLength(0);
  });

  it("lets the loser of a version race write nothing", async () => {
    const h = harness(2);
    const call = await h.inbound({ to: NUMBERS.allianz });
    const before = h.session(call.sessionId).version;

    // Somebody else moved the row on between this writer reading it and
    // writing it.
    const row = h.db.storage("motorist_call_sessions").find((entry) => entry.id === call.sessionId)!;
    row.version = Number(before) + 5;
    const applied = await h.admin.rpc("motorist_apply_critical_v2", {
      p_session_id: call.sessionId, p_expected_version: Number(before),
      p_patch: { state: "ended" }, p_legs: [], p_attempts: [],
    });

    expect((applied.data as unknown as { applied: boolean }).applied).toBe(false);
    expect(h.session(call.sessionId).state).not.toBe("ended");
  });

  it("does not reopen a leg that has already ended", async () => {
    const h = harness(2);
    const call = await h.inbound({ to: NUMBERS.allianz });
    const leg = h.legs(call.sessionId).find((row) => row.role !== "customer")!;
    h.db.update("motorist_call_legs", { ended_at: h.now().toISOString(), state: "ended" }, (row) => row.id === leg.id);

    await h.admin.rpc("motorist_apply_critical_v2", {
      p_session_id: call.sessionId, p_expected_version: null, p_patch: null,
      p_legs: [{ callControlId: leg.telnyx_call_control_id as string, values: { state: "answered" } }], p_attempts: [],
    });

    // A late patch may add detail to a leg that is gone; it may not bring it
    // back.
    const after = h.legs(call.sessionId).find((row) => row.id === leg.id)!;
    expect(after.state).toBe("ended");
    expect(after.ended_at).toBeTruthy();
  });
});
