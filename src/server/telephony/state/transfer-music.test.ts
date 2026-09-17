import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { blindTransfer } from "../call-actions";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

function harness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
}

async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  await h.legEvent(winner, "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  return call;
}

describe("waiting music during a blind transfer", () => {
  it("stops the music it started before the colleague is bridged in", async () => {
    const h = harness();
    const call = await talking(h);

    await completeAnnouncedAction(h, blindTransfer(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 }));
    // The transfer puts the caller on the waiting-room loop while the colleague
    // is dialled.
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ loop: "infinity" });
    const colleague = h.legs(call.sessionId).find(leg => leg.profile_id === PROFILES.o2 && !leg.ended_at)!;
    const before = h.telnyx.calls.length;

    await h.legEvent(String(colleague.telnyx_call_control_id), "call.answered");

    // The loop has to be stopped explicitly. `blindTransferCustomer` starts it
    // with `ring.mode = "transfer"`, and `mohIsPlaying` used to recognise only
    // `"plan"`, so the caller's leg was bridged with a playback still running
    // on it — which Telnyx documents no behaviour for at all.
    const methods = h.telnyx.calls.slice(before).map(entry => entry.method);
    expect(methods).toContain("playbackStop");
    expect(methods.indexOf("bridge")).toBeGreaterThan(-1);
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("does not restart the music when a failed transfer sends the caller to the waiting room", async () => {
    const h = harness();
    const call = await talking(h);
    await completeAnnouncedAction(h, blindTransfer(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 }));
    const started = h.telnyx.of("playbackStart").length;
    const colleague = h.legs(call.sessionId).find(leg => leg.profile_id === PROFILES.o2 && !leg.ended_at)!;

    await h.legEvent(String(colleague.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });

    // The loop is already running: starting a second one would stack two
    // playbacks on the same leg.
    expect(h.telnyx.of("playbackStart")).toHaveLength(started);
  });
});
