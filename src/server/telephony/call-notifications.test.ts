import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import type { CallNotificationDeps } from "./call-notifications";
import { callPushCandidates, loadCallPushCandidates, notifyCallState } from "./call-notifications";
import { mergeMeta, readMeta, type AttemptRow, type LegRow, type PresenceRow, type SessionRow } from "./state/types";
import type { Database } from "@/lib/supabase/database.types";
import { blindTransfer, callColleague, createRateLimiter } from "./call-actions";

type Harness = ReturnType<typeof createTelephonyHarness>;
type ProfileRow = Database["public"]["Tables"]["motorist_profiles"]["Row"];

afterEach(() => vi.unstubAllEnvs());

function world() {
  const h = createTelephonyHarness();
  // An available operator in the organization belongs to a different queue.
  h.db.delete("motorist_ring_group_members", (row) => row.profile_id === PROFILES.o5);
  return h;
}

function deps(h: Harness): CallNotificationDeps {
  return { admin: h.admin, organizationId: ORG, environment: "development", now: h.now, send: vi.fn(async () => ({ sent: 1, failed: 0 })) };
}

function queuedPush(h: Harness) {
  const delivery = deps(h);
  const pending = new Set<string>();
  const scheduled = vi.fn((sessionId: string) => { pending.add(sessionId); });
  h.deps.onCallTransition = scheduled;
  return {
    delivery, scheduled,
    async flush() {
      const sessions = [...pending];
      pending.clear();
      await Promise.all(sessions.map((sessionId) => notifyCallState(delivery, sessionId)));
    },
  };
}

function snapshot(h: Harness, sessionId: string): Parameters<typeof callPushCandidates>[0] {
  return {
    session: h.session(sessionId) as unknown as SessionRow, organizationId: ORG, environment: "development", now: h.now(),
    legs: h.legs(sessionId) as unknown as LegRow[], attempts: h.attempts(sessionId) as unknown as AttemptRow[],
    profiles: h.rows("motorist_profiles") as unknown as ProfileRow[], presence: h.rows("motorist_operator_presence") as unknown as PresenceRow[],
    busyProfileIds: new Set(),
  };
}

function waiting(h: Harness, sessionId: string) {
  const session = h.session(sessionId) as unknown as SessionRow;
  h.db.update("motorist_call_sessions", { state: "waiting", answered_by_profile_id: null, metadata: mergeMeta(session, {
    waiting: { since: h.now().toISOString(), max_minutes: 30, reason: "ring exhausted", ticks: 0 },
  }) }, (row) => row.id === sessionId);
  h.db.update("motorist_call_legs", { state: "ended", ended_at: h.now().toISOString() }, (row) => row.session_id === sessionId && row.role !== "customer");
  h.db.update("motorist_ring_attempts", { result: "no_answer", ended_at: h.now().toISOString() }, (row) => row.session_id === sessionId);
  h.setPresence(PROFILES.o1, { status: "available", current_session_id: null });
  h.setPresence(PROFILES.o2, { status: "available", current_session_id: null });
}

describe("call push audience", () => {
  it("notifies the internal callee after the caller's own leg answers, without a customer leg", async () => {
    const h = world();
    const call = await callColleague({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) },
      { profileId: PROFILES.o1, role: "dispatcher" }, { targetProfileId: PROFILES.o2 });
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
    const push = queuedPush(h);
    expect((await h.legEvent(call.operatorLegCallControlId, "call.answered")).outcome).toBe("processed");
    expect((await loadCallPushCandidates(deps(h), call.sessionId)).map((row) => row.recipientProfileId)).toEqual([PROFILES.o2]);
    expect(push.scheduled).toHaveBeenCalledWith(call.sessionId);
    await push.flush();
    expect(push.delivery.send).toHaveBeenCalledExactlyOnceWith(h.admin, expect.objectContaining({ sessionId: call.sessionId, recipientProfileId: PROFILES.o2, category: "incoming_call" }));
  });

  it("finds a blind transfer target only after Telnyx persists its incoming leg", async () => {
    const h = world();
    const call = await h.inbound();
    const winner = h.legFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
    const loser = h.legFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(loser.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    await blindTransfer({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) },
      { profileId: PROFILES.o1, role: "dispatcher" }, call.sessionId, { profileId: PROFILES.o2 });
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
    await completeCallAnnouncements(h, call.sessionId);
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
    const transfer = h.telnyx.of("transfer")[0].params;
    const push = queuedPush(h);
    const result = await h.process(h.envelope("call.initiated", { call_control_id: "cc-transfer", call_leg_id: "leg-transfer", call_session_id: call.telnyxSessionId,
      client_state: transfer.targetLegClientState, direction: "outgoing", to: "sip:gencred002@sip.telnyx.com" }));
    expect(result.outcome).toBe("processed");
    expect((await loadCallPushCandidates(deps(h), call.sessionId)).map((row) => row.recipientProfileId)).toEqual([PROFILES.o2]);
    expect(push.scheduled).toHaveBeenCalledWith(call.sessionId);
    await push.flush();
    expect(push.delivery.send).toHaveBeenCalledExactlyOnceWith(h.admin, expect.objectContaining({ sessionId: call.sessionId, recipientProfileId: PROFILES.o2, category: "incoming_call" }));
  });

  it("notifies the recorded blind-transfer target after its dial, but suppresses delayed push once its answer notice starts", async () => {
    vi.stubEnv("TELNYX_RECORDING_ENABLED", "true");
    vi.stubEnv("TELNYX_RECORDING_CONTRACT_VERIFIED", "true");
    vi.stubEnv("RECORDING_PROCESSING_ENABLED", "true");
    vi.stubEnv("TELNYX_RECORDING_TRANSFER_VERIFIED", "true");
    const h = world();
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
    const call = await h.inbound();
    await completeCallAnnouncements(h, call.sessionId);
    const winner = h.openLegFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
    const loser = h.openLegFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(loser.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    const push = queuedPush(h);
    await blindTransfer(h.deps, { profileId: PROFILES.o1, role: "dispatcher" }, call.sessionId, { profileId: PROFILES.o2 });
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
    await completeCallAnnouncements(h, call.sessionId);
    const target = h.openLegFor(call.sessionId, PROFILES.o2)!;
    expect(h.clientStateOf(String(target.telnyx_call_control_id)).intent).toBe("transfer_recorded");
    expect(h.telnyx.of("transfer")).toHaveLength(0);
    expect(push.scheduled).toHaveBeenCalledWith(call.sessionId);
    await push.flush();
    expect(push.delivery.send).toHaveBeenCalledExactlyOnceWith(h.admin, expect.objectContaining({ sessionId: call.sessionId, recipientProfileId: PROFILES.o2, category: "incoming_call" }));

    vi.mocked(push.delivery.send!).mockClear();
    push.scheduled.mockClear();
    expect((await h.legEvent(String(target.telnyx_call_control_id), "call.answered")).outcome).toBe("processed");
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence?.continuation).toMatchObject({ kind: "telnyx", type: "call.answered", callControlId: target.telnyx_call_control_id });
    expect(h.openLegFor(call.sessionId, PROFILES.o2)?.answered_at).toBeNull();
    expect(push.scheduled).toHaveBeenCalledWith(call.sessionId);
    await push.flush();
    expect(push.delivery.send).not.toHaveBeenCalled();
    await completeCallAnnouncements(h, call.sessionId);
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
  });

  it("targets only actual offered operators and limits expiry to the remaining ring deadline", async () => {
    const h = world();
    const call = await h.inbound();
    const initial = await loadCallPushCandidates(deps(h), call.sessionId);
    expect(initial.map((row) => row.recipientProfileId).sort()).toEqual([PROFILES.o1, PROFILES.o2]);
    expect(initial.every((row) => row.category === "incoming_call")).toBe(true);
    h.advance(19_000);
    const lastSecond = await loadCallPushCandidates(deps(h), call.sessionId);
    expect(lastSecond.length).toBe(2);
    expect(Date.parse(lastSecond[0].expiresAt) - h.now().getTime()).toBe(1_000);
    h.advance(1_001);
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
  });

  it("wakes available queue members with stale or absent SIP devices, excluding unrelated operators", async () => {
    const h = world();
    const call = await h.inbound();
    waiting(h, call.sessionId);
    h.touchDevice(PROFILES.o1, 600_000);
    h.db.delete("motorist_operator_devices", (row) => row.profile_id === PROFILES.o2);
    const rows = await loadCallPushCandidates(deps(h), call.sessionId);
    expect(rows.map((row) => row.recipientProfileId).sort()).toEqual([PROFILES.o1, PROFILES.o2]);
    expect(rows.every((row) => row.category === "available_call")).toBe(true);
    expect(rows.some((row) => row.recipientProfileId === PROFILES.o5)).toBe(false);
    expect(Date.parse(rows[0].expiresAt) - h.now().getTime()).toBe(30_000);
  });

  it.each(["offline", "paused", "on_call", "ringing", "after_call_work"])("excludes a waiting recipient whose status is %s", async (status) => {
    const h = world();
    const call = await h.inbound();
    waiting(h, call.sessionId);
    h.setPresence(PROFILES.o1, { status, current_session_id: status === "ringing" ? "another-session" : null, wrap_up_until: new Date(h.now().getTime() + 60_000).toISOString() });
    expect((await loadCallPushCandidates(deps(h), call.sessionId)).map((row) => row.recipientProfileId)).toEqual([PROFILES.o2]);
  });

  it("excludes deactivated profiles, foreign organization/environment and a caller that has already hung up", async () => {
    const h = world();
    const call = await h.inbound();
    h.db.update("motorist_profiles", { active: false }, (row) => row.id === PROFILES.o1);
    h.db.update("motorist_profiles", { access_status: "disabled" }, (row) => row.id === PROFILES.o2);
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
    expect(await loadCallPushCandidates({ ...deps(h), organizationId: "foreign-org" }, call.sessionId)).toEqual([]);
    expect(await loadCallPushCandidates({ ...deps(h), environment: "production" }, call.sessionId)).toEqual([]);
    h.db.update("motorist_profiles", { active: true, access_status: "active" }, () => true);
    h.db.update("motorist_call_legs", { state: "ended", ended_at: h.now().toISOString() }, (row) => row.session_id === call.sessionId && row.role === "customer");
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
  });

  it("does not summon operators while pickup is pending, after waiting expires, or after the session ends", async () => {
    const h = world();
    const call = await h.inbound();
    waiting(h, call.sessionId);
    const input = snapshot(h, call.sessionId);
    input.session.metadata = mergeMeta(input.session, { pickup: { by: PROFILES.o1, at: h.now().toISOString() } });
    expect(callPushCandidates(input)).toEqual([]);
    input.now = new Date(h.now().getTime() + 31_000);
    expect(callPushCandidates(input).length).toBe(2);
    input.now = new Date(h.now().getTime() + 31 * 60_000);
    expect(callPushCandidates(input)).toEqual([]);
    input.now = h.now();
    input.session.ended_at = h.now().toISOString();
    expect(callPushCandidates(input)).toEqual([]);
  });

  it("treats other offered calls and live media legs as busy even if presence incorrectly says available", async () => {
    const h = world();
    const call = await h.inbound();
    waiting(h, call.sessionId);
    h.db.seed("motorist_ring_attempts", [{ organization_id: ORG, profile_id: PROFILES.o1, session_id: "other-call", step_index: 1, result: "offered", ended_at: null }]);
    h.db.seed("motorist_call_legs", [{ organization_id: ORG, profile_id: PROFILES.o2, session_id: "other-call", role: "supervisor", state: "answered", ended_at: null }]);
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
  });

  it("rejects conflicting current_session_id and a cancelled ring attempt", async () => {
    const h = world();
    const call = await h.inbound();
    h.setPresence(PROFILES.o1, { status: "available", current_session_id: "other-call" });
    h.db.update("motorist_ring_attempts", { result: "cancelled" }, (row) => row.session_id === call.sessionId && row.profile_id === PROFILES.o2);
    expect(await loadCallPushCandidates(deps(h), call.sessionId)).toEqual([]);
  });

  it("does not treat an operator still ringing this session as available for manual pickup", async () => {
    const h = world();
    const call = await h.inbound();
    waiting(h, call.sessionId);
    h.setPresence(PROFILES.o1, { status: "ringing", current_session_id: call.sessionId });
    expect((await loadCallPushCandidates(deps(h), call.sessionId)).map((row) => row.recipientProfileId)).toEqual([PROFILES.o2]);
  });

  it.each(["internal", "transfer", "transfer_recorded", "consult", "party"])("recognizes a real %s target without notifying an automatically answered own leg", async (intent) => {
    const h = world();
    const call = await h.inbound();
    const input = snapshot(h, call.sessionId);
    const target = { kind: "operator" as const, profileId: PROFILES.o1, sipUri: "sip:operator@example.test", label: "Operator" };
    const targetLeg = input.legs.find((leg) => leg.profile_id === PROFILES.o1)!;
    targetLeg.client_state = { intent, autoAnswer: false };
    if (intent === "internal") {
      input.session.direction = "internal";
      input.session.metadata = mergeMeta(input.session, { internal: { by: PROFILES.o5, target_profile_id: PROFILES.o1, target_sip: target.sipUri } });
      input.legs.find((leg) => leg.role === "customer")!.client_state = { intent: "internal_caller", autoAnswer: true };
    } else if (intent === "transfer" || intent === "transfer_recorded") {
      input.session.metadata = mergeMeta(input.session, { transfer: { kind: "blind", target, by: PROFILES.o5, at: h.now().toISOString() } });
    } else if (intent === "consult") {
      input.session.state = "consulting";
      input.session.metadata = mergeMeta(input.session, { consult: { target, by: PROFILES.o5, at: h.now().toISOString() } });
      targetLeg.role = "consult";
    } else {
      input.session.state = "talking";
      input.session.metadata = mergeMeta(input.session, { party_pending: { target, by: PROFILES.o5, at: h.now().toISOString() } });
    }
    const other = input.legs.find((leg) => leg.profile_id === PROFILES.o2)!;
    other.client_state = { intent: "outbound", autoAnswer: true };
    expect(callPushCandidates(input).map((row) => row.recipientProfileId)).toEqual([PROFILES.o1]);
    targetLeg.client_state = { intent, autoAnswer: true };
    expect(callPushCandidates(input)).toEqual([]);
  });
});

describe("call push delivery scheduling", () => {
  it("passes the remaining shared deadline to delivery and starts no sends after it expires", async () => {
    const h = world();
    const call = await h.inbound();
    const delivery = deps(h);
    let clock = h.now().getTime();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      delivery.deadlineAt = clock + 4_000;
      expect(await notifyCallState(delivery, call.sessionId)).toEqual({ sent: 2, failed: 0 });
      expect(delivery.send).toHaveBeenCalledWith(h.admin, expect.objectContaining({ expiresAt: new Date(delivery.deadlineAt).toISOString() }));
      vi.mocked(delivery.send!).mockClear();
      clock += 4_001;
      expect(await notifyCallState(delivery, call.sessionId)).toEqual({ sent: 0, failed: 0 });
      expect(delivery.send).not.toHaveBeenCalled();
    } finally { dateNow.mockRestore(); }
  });

  it("rechecks the persisted state before sending and suppresses a call answered during audience lookup", async () => {
    const h = world();
    const call = await h.inbound();
    const delivery = deps(h);
    const from = h.client.from.bind(h.client);
    let sessionReads = 0;
    const spy = vi.spyOn(h.client, "from").mockImplementation((table) => {
      if (table === "motorist_call_sessions" && ++sessionReads === 2) h.db.update("motorist_call_sessions", { state: "talking", answered_by_profile_id: PROFILES.o1 }, (row) => row.id === call.sessionId);
      return from(table);
    });
    expect(await notifyCallState(delivery, call.sessionId)).toEqual({ sent: 0, failed: 0 });
    expect(delivery.send).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("awaits delivery, isolates provider failures, and never issues telephony commands itself", async () => {
    const h = world();
    const call = await h.inbound();
    const delivery = deps(h);
    delivery.send = vi.fn().mockRejectedValueOnce(new Error("push unavailable")).mockResolvedValueOnce({ sent: 1, failed: 0 });
    const dialCount = h.telnyx.of("dial").length;
    expect(await notifyCallState(delivery, call.sessionId)).toEqual({ sent: 1, failed: 1 });
    expect(delivery.send).toHaveBeenCalledTimes(2);
    expect(h.telnyx.of("dial")).toHaveLength(dialCount);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("fails closed when audience storage fails", async () => {
    const h = world();
    const call = await h.inbound();
    const delivery = deps(h);
    h.db.failNext("motorist_operator_presence", "select", "unavailable");
    await expect(notifyCallState(delivery, call.sessionId)).rejects.toThrow("Call push audience unavailable");
    expect(delivery.send).not.toHaveBeenCalled();
  });
});
