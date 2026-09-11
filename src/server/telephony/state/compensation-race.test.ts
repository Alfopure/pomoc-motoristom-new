import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { TelnyxCommandError } from "../telnyx/client";
import { readPendingEffects } from "./continuation";
import { readMeta, type SessionRow } from "./types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("late bridge compensation", () => {
  it.each([false, true])("does not return a departed customer to waiting with durable effects=%s", async durable => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", String(durable));
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    let departedAt = "";
    vi.spyOn(h.telnyx.client, "bridge").mockImplementationOnce(async () => {
      // The provider request outlives its lease, and teardown finishes before
      // the original bridge rejection returns to its invocation.
      h.advance(16_000);
      departedAt = h.now().toISOString();
      expect(await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" }))
        .toMatchObject({ outcome: "processed" });
      expect(h.session(call.sessionId).state).toBe("wrap_up");
      throw new TelnyxCommandError({ code: "90018", status: 422, detail: "Call has already ended" });
    });
    const gathersBefore = h.telnyx.of("gather").length;

    await h.legEvent(operator, "call.answered");

    expect(h.session(call.sessionId)).toMatchObject({ state: "wrap_up", answered_by_profile_id: PROFILES.o1 });
    expect(readMeta(h.session(call.sessionId) as SessionRow).waiting).toBeFalsy();
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended", ended_at: departedAt, end_reason: "caller_hangup" });
    expect(h.presence(PROFILES.o1).status).toBe("after_call_work");
    expect(h.telnyx.of("gather")).toHaveLength(gathersBefore);
    for (const leg of h.legs(call.sessionId).filter(leg => !leg.ended_at)) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "normal_clearing" });
    }
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
  });

  it.each([false, true])("still moves a connected customer to waiting after a real bridge failure with durable effects=%s", async durable => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", String(durable));
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    h.telnyx.failNext("bridge", new TelnyxCommandError({ code: "bridge_rejected", status: 422, detail: "Bridge refused" }));

    await h.legEvent(operator, "call.answered");

    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", ended_at: null });
    expect(readMeta(h.session(call.sessionId) as SessionRow).waiting?.reason).toBe("bridge_failed");
    expect(h.telnyx.of("hangup").some(entry => entry.params.callControlId === operator)).toBe(true);
  });
});
