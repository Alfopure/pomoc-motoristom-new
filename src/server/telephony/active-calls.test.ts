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
        expect.objectContaining({ profileId: PROFILES.o1, status: "available", currentSessionId: null }),
        expect.objectContaining({ profileId: PROFILES.o3, status: "offline", currentSessionId: null }),
      ]),
    );
    expect(snapshot.ownPresence).toEqual({ presenceRevision: 0, automaticOffersAllowed: true, status: "available", pauseReasonId: null, statusSince: h.now().toISOString() });
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

  it("exposes browser call identities only for the polling actor's operator and consult legs", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    const ownLeg = h.db.rows("motorist_call_legs").find((leg) => leg.session_id === sessionId && leg.profile_id === PROFILES.o1);
    expect(ownLeg).toBeDefined();

    for (const role of ["operator", "consult", "supervisor", "customer", "external"] as const) {
      h.db.update("motorist_call_legs", { role }, (leg) => leg.id === ownLeg!.id);
      const snapshot = await loadActiveCalls(deps(h), { profileId: PROFILES.o1, canManageAssignments: false });
      const legs = snapshot.calls[0].legs;
      expect(legs.find((leg) => leg.id === ownLeg!.id)?.callControlId).toBe(
        role === "operator" || role === "consult" ? ownLeg!.telnyx_call_control_id : null,
      );
      expect(legs.filter((leg) => leg.id !== ownLeg!.id).every((leg) => leg.callControlId === null)).toBe(true);
    }

    // A second operator's response gets their own ID, never the first actor's.
    const colleague = await loadActiveCalls(deps(h), { profileId: PROFILES.o2, canManageAssignments: false });
    const colleagueLeg = colleague.calls[0].legs.find((leg) => leg.profileId === PROFILES.o2 && leg.role === "operator");
    expect(colleagueLeg?.callControlId).toBeTruthy();
    expect(colleague.calls[0].legs.find((leg) => leg.id === ownLeg!.id)?.callControlId).toBeNull();
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

  it("an outgoing customer answer waits for both current bridge confirmations without recording metadata", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    const answeredAt = h.now().toISOString();
    h.db.update("motorist_call_sessions", { direction: "outbound", state: "talking", answered_at: answeredAt, answered_by_profile_id: PROFILES.o1, metadata: {} }, row => row.id === sessionId);
    h.db.update("motorist_call_legs", { answered_at: answeredAt, bridged_at: null, state: "answered" }, row => row.session_id === sessionId && (row.role === "customer" || row.profile_id === PROFILES.o1));
    const connection = async () => (await loadActiveCalls(deps(h), { profileId: PROFILES.o1, canManageAssignments: false })).calls[0].audioConnection;
    expect(await connection()).toEqual({ status: "connecting", startedAt: answeredAt, confirmedAt: null, error: null });
    h.advance(5_000);
    h.db.update("motorist_call_legs", { bridged_at: h.now().toISOString(), state: "bridged" }, row => row.session_id === sessionId && row.role === "customer");
    // A different operator's confirmation must not match this conversation.
    h.db.update("motorist_call_legs", { answered_at: answeredAt, bridged_at: h.now().toISOString(), state: "bridged" }, row => row.session_id === sessionId && row.profile_id === PROFILES.o2);
    expect((await connection())?.status).toBe("connecting");
    h.advance(30_000);
    expect(await connection()).toMatchObject({ status: "failed", error: "connection_confirmation_timeout" });
    const confirmedAt = h.now().toISOString();
    h.db.update("motorist_call_legs", { bridged_at: confirmedAt, state: "bridged" }, row => row.session_id === sessionId && row.profile_id === PROFILES.o1);
    expect(await connection()).toEqual({ status: "connected", startedAt: answeredAt, confirmedAt, error: null });
    // Incoming calls keep their existing recording and connection semantics.
    h.db.update("motorist_call_sessions", { direction: "inbound" }, row => row.id === sessionId);
    expect(await connection()).toBeNull();
  });
});
