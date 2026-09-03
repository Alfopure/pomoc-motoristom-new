import { describe, expect, it } from "vitest";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

import { loadActiveCalls } from "./active-calls";

function deps(h: ReturnType<typeof createTelephonyHarness>) {
  return { admin: h.admin, organizationId: ORG, environment: "development" as const, configured: true, now: () => h.now() };
}

describe("active calls snapshot", () => {
  it("returns an empty snapshot with presence and device registration", async () => {
    const h = createTelephonyHarness();
    const snapshot = await loadActiveCalls(deps(h), { profileId: PROFILES.o1, canManageAssignments: false });

    expect(snapshot.calls).toEqual([]);
    expect(snapshot.waiting).toEqual([]);
    expect(snapshot.configured).toBe(true);
    expect(snapshot.presence.actorProfileId).toBe(PROFILES.o1);
    expect(snapshot.presence.presence).toEqual(
      expect.arrayContaining([
        { profileId: PROFILES.o1, status: "available", currentSessionId: null },
        { profileId: PROFILES.o3, status: "offline", currentSessionId: null },
      ]),
    );
    expect(snapshot.presence.devices.find((device) => device.profileId === PROFILES.o1)?.registered).toBe(true);
  });

  it("projects an inbound ringing session with its line label, offers and open legs", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });

    const snapshot = await loadActiveCalls(deps(h), { profileId: PROFILES.o1, canManageAssignments: false });
    expect(snapshot.calls).toHaveLength(1);
    const call = snapshot.calls[0];
    expect(call).toMatchObject({
      sessionId,
      state: "ringing",
      direction: "inbound",
      lineLabel: "Allianz Assistance",
      partnerName: "Allianz Assistance",
      calledNumber: "+421232408718",
      mine: true,
    });
    expect(call.offeredProfileIds).toEqual(expect.arrayContaining([PROFILES.o1, PROFILES.o2]));
    // The console links a live call to a case through the call-log row, so its
    // id has to travel with the snapshot.
    const callRow = h.db.rows("motorist_calls").find((row) => row.session_id === sessionId);
    expect(call.callId).toBe(callRow?.id ?? null);
    expect(call.callId).not.toBeNull();
    expect(call.legs.some((leg) => leg.role === "customer")).toBe(true);
    expect(call.legs.filter((leg) => leg.role === "operator").length).toBeGreaterThan(0);
  });

  it("keeps waiting-room sessions in a separate bucket and marks foreign calls as not mine", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "waiting", answered_by_profile_id: PROFILES.o2, metadata: { waiting: { since: h.now().toISOString(), reason: "operator_left", ticks: 1 } } }, (row) => row.id === sessionId);
    h.db.update("motorist_ring_attempts", { result: "cancelled" }, (row) => row.session_id === sessionId);

    const snapshot = await loadActiveCalls(deps(h), { profileId: PROFILES.o3, canManageAssignments: true });
    expect(snapshot.waiting.map((call) => call.sessionId)).toEqual([sessionId]);
    expect(snapshot.waiting[0].waitingSince).toBe(h.now().toISOString());
    expect(snapshot.calls[0].mine).toBe(false);
    expect(snapshot.presence.canManageAssignments).toBe(true);
  });

  it("names the operator who parked a caller and the limit they arrived with", async () => {
    // The waiting room has to be able to say who odložil the caller and how
    // long they still have before the state machine offers them a callback.
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update(
      "motorist_call_sessions",
      {
        state: "parked",
        answered_by_profile_id: null,
        parked_at: h.now().toISOString(),
        metadata: {
          park: { by: PROFILES.o2, at: h.now().toISOString() },
          waiting: { since: h.now().toISOString(), reason: "parked", ticks: 0, max_minutes: 30 },
        },
      },
      (row) => row.id === sessionId,
    );
    h.db.update("motorist_ring_attempts", { result: "cancelled" }, (row) => row.session_id === sessionId);

    const snapshot = await loadActiveCalls(deps(h), { profileId: PROFILES.o1, canManageAssignments: false });

    expect(snapshot.waiting[0]).toMatchObject({
      state: "parked",
      parkedAt: h.now().toISOString(),
      parkedByProfileId: PROFILES.o2,
      waitingReason: "parked",
      waitingMaxMinutes: 30,
    });
  });

  it("ignores ended sessions", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "ended", ended_at: h.now().toISOString() }, (row) => row.id === sessionId);

    const snapshot = await loadActiveCalls(deps(h), { profileId: PROFILES.o1, canManageAssignments: false });
    expect(snapshot.calls).toEqual([]);
  });
});
