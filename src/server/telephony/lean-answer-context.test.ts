import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { loadRoutingContext, loadSessionSnapshot } from "./session-runner";
import type { SessionEvent, SessionRow } from "./state/types";

afterEach(() => vi.unstubAllEnvs());

async function ringing(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  expect(h.session(call.sessionId).state).toBe("ringing");
  const operator = h.legFor(call.sessionId, PROFILES.o1)!;
  return { call, operatorControlId: String(operator.telnyx_call_control_id) };
}

function answered(callControlId: string, intent: string): SessionEvent {
  return { kind: "telnyx", id: `evt-${intent}`, type: "call.answered", occurredAt: null, callControlId,
    callLegId: null, callSessionId: null, connectionId: null, rawClientState: null, from: null, to: null,
    direction: null, state: null, payload: {}, clientState: { sid: "ignored", role: "operator", intent } } as unknown as SessionEvent;
}

const contextFor = async (h: TelephonyHarness, sessionId: string, event: SessionEvent) => {
  const snapshot = await loadSessionSnapshot(h.deps, sessionId);
  return loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs);
};

describe("routing context for an accepted offer", () => {
  it("skips the line, IVR, capacity and roster the transition never reads", async () => {
    const h = createTelephonyHarness();
    const { call, operatorControlId } = await ringing(h);
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const before = h.db.log.length;

    const context = await loadRoutingContext(h.deps, snapshot.session, answered(operatorControlId, "ring"), snapshot.legs);

    expect(context.lean).toBe(true);
    // One read: the waiting-room limit the bridge compensation falls back to.
    expect(h.db.log.length - before).toBe(1);
    expect(context.settings.parkMaxMinutes).toBeGreaterThan(0);
    // Not `false`: the answer has to see the ring music to stop it.
    expect(context.mediaAvailable).toBe(true);
    expect(context.presence).toEqual([]);
    expect(context.devices).toEqual([]);
  });

  it.each(["ring", "pickup", "transfer", "transfer_safe"])("covers the %s intent", async intent => {
    const h = createTelephonyHarness();
    const { call, operatorControlId } = await ringing(h);

    expect((await contextFor(h, call.sessionId, answered(operatorControlId, intent))).lean).toBe(true);
  });

  it("leaves an internal call on the full context", async () => {
    const h = createTelephonyHarness();
    const { call, operatorControlId } = await ringing(h);

    // `internal` branches to `onInternalCalleeAnswered`, a different path with
    // its own bridge, and an internal session never freezes a recording policy.
    expect((await contextFor(h, call.sessionId, answered(operatorControlId, "internal"))).lean).toBeUndefined();
  });

  it("leaves the customer's own answer on the full context", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });

    expect((await contextFor(h, call.sessionId, answered(call.callControlId, "ring"))).lean).toBeUndefined();
  });

  it("loads everything again once recording is in play", async () => {
    const h = createTelephonyHarness();
    const { call, operatorControlId } = await ringing(h);
    const session = h.session(call.sessionId) as SessionRow;
    const meta = session.metadata as Record<string, unknown>;
    const recording = meta.recording as { policy: Record<string, unknown> };
    h.db.update("motorist_call_sessions",
      { metadata: { ...meta, recording: { ...recording, policy: { ...recording.policy, enabled: true } } } },
      row => row.id === call.sessionId);

    // `reduce` runs `reduceRecording`, whose eligibility and lease decisions
    // read the live policy. A frozen one may only stand in for it when
    // recording is frozen off.
    expect((await contextFor(h, call.sessionId, answered(operatorControlId, "ring"))).lean).toBeUndefined();
  });

  it("never hands a lean context to a sweep, which plans the next ring step", async () => {
    const h = createTelephonyHarness();
    const { call } = await ringing(h);
    const sweep: SessionEvent = { kind: "app", type: "sweep", id: "follow", actorProfileId: null, occurredAt: h.now().toISOString() };

    const context = await contextFor(h, call.sessionId, sweep);

    // An empty roster is not an absent one: a sweep on a lean context would
    // step over every operator. This is what the follow loop reloads for.
    expect(context.lean).toBeUndefined();
    expect(context.presence.length).toBeGreaterThan(0);
    expect(context.devices.length).toBeGreaterThan(0);
  });
});
