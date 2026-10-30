import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { callColleague, createRateLimiter } from "./call-actions";
import { readContactHistory } from "./contact-proof";
import { defaultLatencyFlags, type LatencyFlags } from "./latency-flags";
import { readPendingEffects } from "./state/continuation";
import { readMeta, type SessionRow } from "./state/types";
import { encodeClientState } from "./telnyx/client-state";

/**
 * Call-speed S1.2 (`bridged_observation_fast`): the first `call.bridged` of an
 * answered leg records its fact with one fenced row write and audits after
 * the lease; an exact duplicate is acknowledged without the lease. Every
 * precondition that keeps the staged path is exercised here.
 */

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FAST = { internal_lean_path: true, bridged_observation_fast: true } as const;

function harness(flags: Partial<LatencyFlags> = FAST) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), ...flags };
  return h;
}

/** A colleague call up to (not including) the colleague's answer. */
async function ringingColleague(h: TelephonyHarness) {
  const call = await callColleague({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) }, actor,
    { targetProfileId: PROFILES.o2, requestId: requestId(9301) });
  h.telnyx.physical.answered(call.operatorLegCallControlId);
  await h.legEvent(call.operatorLegCallControlId, "call.answered");
  const callee = String(h.openLegFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
  h.telnyx.physical.answered(callee);
  return { call, callee };
}

async function talkingColleague(h: TelephonyHarness) {
  const ringing = await ringingColleague(h);
  await h.legEvent(ringing.callee, "call.answered");
  expect(h.session(ringing.call.sessionId).state).toBe("talking");
  return ringing;
}

const leg = (h: TelephonyHarness, sessionId: string, callControlId: string) =>
  h.legs(sessionId).find(row => row.telnyx_call_control_id === callControlId)!;
const named = (h: TelephonyHarness, from: number, table: string) => h.db.log.slice(from).filter(row => row.table === table);
/** Whether a run since `from` (an index into `h.logs`) took the observation-only branch. */
const observed = (h: TelephonyHarness, from: number) => h.logs.slice(from).some(entry => entry.scope === "session" && entry.branch === "observation");

describe("observation-only call.bridged", () => {
  it("writes the leg's state and bridged_at exactly once, with no stage, checkpoint or finalize, and audits after the release", async () => {
    const h = harness();
    const { call, callee } = await talkingColleague(h);
    const from = h.db.log.length, logsFrom = h.logs.length;

    const result = await h.legEvent(callee, "call.bridged");

    expect(result).toMatchObject({ status: 200, outcome: "processed" });
    expect(observed(h, logsFrom)).toBe(true);
    const writes = named(h, from, "motorist_apply_critical_v2");
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({ p_expected_version: null, p_patch: null, p_attempts: [],
      p_legs: [{ callControlId: callee, values: { state: "bridged", bridged_at: expect.any(String) } }] });
    expect(named(h, from, "motorist_stage_transition_v1")).toHaveLength(0);
    // Neither checkpoint nor finalize: no session write besides the fenced one.
    expect(h.db.log.slice(from).filter(row => row.operation === "update" && ["motorist_call_sessions", "motorist_call_legs"].includes(row.table))).toHaveLength(0);
    expect(leg(h, call.sessionId, callee)).toMatchObject({ state: "bridged", bridged_at: expect.any(String) });
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toHaveLength(0);
    // Audit after the lease is released, the ledger after the audit.
    const order = h.db.log.slice(from);
    const release = order.findIndex(row => row.table === "motorist_session_lease_release_v2");
    const audit = order.findIndex(row => row.table === "motorist_call_events" && row.operation === "upsert");
    const finish = order.findIndex(row => row.table === "motorist_telnyx_finish_webhook_event_v2");
    expect(release).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(release);
    expect(finish).toBeGreaterThan(audit);
    const row = h.callEvents(call.sessionId).find(entry => entry.event_type === "call.bridged")!;
    expect(row).toMatchObject({ handled_status: "processed" });
    expect((row.normalized_payload as { notes: string[] }).notes).toContain("observation only");
    expect(h.session(call.sessionId).lease_token).toBeNull();
  });

  it("keeps the staged path while the switch is off", async () => {
    const h = harness({ internal_lean_path: true });
    const { call, callee } = await talkingColleague(h);
    const from = h.db.log.length, logsFrom = h.logs.length;

    await h.legEvent(callee, "call.bridged");

    expect(observed(h, logsFrom)).toBe(false);
    expect(named(h, from, "motorist_stage_transition_v1")).toHaveLength(1);
    expect(leg(h, call.sessionId, callee)).toMatchObject({ state: "bridged", bridged_at: expect.any(String) });
  });

  it("keeps the staged path while the journal holds an unknown command, where this event may be its evidence", async () => {
    const h = harness();
    const { call, callee } = await talkingColleague(h);
    h.db.registerRpc("motorist_provider_pending_commands_v2", () => [{ commandId: "unknown-1", fingerprint: "f", path: "/calls/x/actions/hangup",
      payload: {}, dispatchGeneration: 1, dispatchToken: "t", firstDispatchedAt: h.now().toISOString(), correlationState: null }]);
    const logsFrom = h.logs.length;

    await h.legEvent(callee, "call.bridged");

    expect(observed(h, logsFrom)).toBe(false);
    expect(leg(h, call.sessionId, callee).bridged_at).toBeTruthy();
  });

  it("keeps the staged path while effects are pending", async () => {
    const h = harness();
    const { call, callee } = await talkingColleague(h);
    const session = h.session(call.sessionId) as SessionRow;
    h.db.update("motorist_call_sessions", { pending_effects: { version: 1, entries: [{ id: "left-behind", generation: 0, createdAt: h.now().toISOString(),
      event: { kind: "app", type: "sweep", id: "left-behind", actorProfileId: null, occurredAt: h.now().toISOString() }, stateBefore: session.state,
      previousConferenceId: null, branch: "main", transition: { session: {}, legs: [], attempts: [], presence: [], callbacks: [], call: {}, memberTouches: [], notes: [] },
      commands: [], compensations: [], databaseCursor: 0, completedCommands: [], attempts: 0, lastError: null, auditComplete: false }] } },
      row => row.id === call.sessionId);
    const logsFrom = h.logs.length;

    await h.legEvent(callee, "call.bridged");

    expect(observed(h, logsFrom)).toBe(false);
    expect(leg(h, call.sessionId, callee).bridged_at).toBeTruthy();
  });

  it.each([
    ["offer cancellations", { cancellations_next_attempt_at: "2099-01-01T00:00:00.000Z" }],
    ["a committed termination", { termination_requested_at: "2026-09-03T08:00:00.000Z" }],
  ])("keeps the staged path while %s are owed", async (_name, values) => {
    const h = harness();
    const { call, callee } = await talkingColleague(h);
    h.db.update("motorist_call_sessions", values, row => row.id === call.sessionId);
    const logsFrom = h.logs.length;

    await h.legEvent(callee, "call.bridged");

    expect(observed(h, logsFrom)).toBe(false);
  });

  it("keeps the staged path for a call being recorded", async () => {
    const h = harness();
    const { call, callee } = await talkingColleague(h);
    const session = h.session(call.sessionId) as SessionRow;
    h.db.update("motorist_call_sessions", { metadata: { ...readMeta(session), recording: { version: 1, policy: { enabled: true, inbound: true, outbound: true },
      epoch: 0, noticeCompletedAt: null, noticeFailed: false, suppressedAt: null, suppressionReason: null, recorders: [], error: null } } }, row => row.id === call.sessionId);
    const logsFrom = h.logs.length;

    await h.legEvent(callee, "call.bridged");

    expect(observed(h, logsFrom)).toBe(false);
    expect(leg(h, call.sessionId, callee).bridged_at).toBeTruthy();
  });

  it("keeps the staged path while callback contact is being accounted", async () => {
    // An answered inbound call owns a contact operation that its bridge proves.
    vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
    const h = harness();
    const inbound = await h.inbound({ to: NUMBERS.allianz });
    const operator = String(h.legFor(inbound.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    await h.legEvent(operator, "call.answered");
    expect(h.session(inbound.sessionId).state).toBe("talking");
    expect(readMeta(h.session(inbound.sessionId) as SessionRow).recording?.policy.enabled).toBe(false);
    expect(readContactHistory(h.session(inbound.sessionId) as SessionRow).operations.length).toBeGreaterThan(0);
    const logsFrom = h.logs.length;

    await h.legEvent(operator, "call.bridged");

    expect(observed(h, logsFrom)).toBe(false);
  });

  it("still answers a bridge that arrives before the answer, which is not leg-patch-only", async () => {
    const h = harness();
    const { call, callee } = await ringingColleague(h);
    const from = h.db.log.length, logsFrom = h.logs.length;

    // Out of order: Telnyx delivered call.bridged first. It is the answer.
    await h.legEvent(callee, "call.bridged");

    expect(observed(h, logsFrom)).toBe(false);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(leg(h, call.sessionId, callee)).toMatchObject({ answered_at: expect.any(String), bridged_at: expect.any(String) });
    expect(named(h, from, "motorist_stage_transition_v1")).toHaveLength(1);
    expect(h.telnyx.of("bridge").length).toBeGreaterThan(0);

    // The late answer is a duplicate of that fact.
    const late = await h.legEvent(callee, "call.answered");
    expect(late.outcome).toBe("ignored");
  });
});

describe("exact duplicate call.bridged", () => {
  const redeliver = (h: TelephonyHarness, sessionId: string, callee: string) => h.process(h.envelope("call.bridged", {
    call_control_id: callee, call_leg_id: leg(h, sessionId, callee).telnyx_call_leg_id, call_session_id: h.session(sessionId).telnyx_session_id,
    client_state: encodeClientState(h.clientStateOf(callee)),
  }));

  it("is acknowledged without the session lease, even while another invocation holds it", async () => {
    const h = harness();
    const { call, callee } = await talkingColleague(h);
    await h.legEvent(callee, "call.bridged");
    h.db.rpcHandlers.get("motorist_session_lease_acquire_v2")!({ p_session_id: call.sessionId, p_token: "holder", p_ttl_ms: 30_000 }, h.db);
    const before = { ...leg(h, call.sessionId, callee) };
    const from = h.db.log.length;

    const result = await redeliver(h, call.sessionId, callee);

    expect(result).toMatchObject({ status: 200, outcome: "ignored", notes: ["leg already bridged", "lease-free"] });
    expect(named(h, from, "motorist_session_lease_acquire_v2")).toHaveLength(0);
    expect(leg(h, call.sessionId, callee)).toEqual(before);
    expect(h.callEvents(call.sessionId).filter(row => row.event_type === "call.bridged" && row.handled_status === "ignored")).toHaveLength(1);
  });

  it("goes through the lease when an unknown command exists, and the reducer ignores it there", async () => {
    const h = harness();
    const { call, callee } = await talkingColleague(h);
    await h.legEvent(callee, "call.bridged");
    h.db.seed("motorist_provider_commands", [{ session_id: call.sessionId, command_id: "pending-x", outcome: "unknown", method: "POST", path: "/calls" }]);
    const before = { ...leg(h, call.sessionId, callee) };
    const from = h.db.log.length;

    const result = await redeliver(h, call.sessionId, callee);

    expect(result).toMatchObject({ status: 200, outcome: "ignored", notes: ["leg already bridged"] });
    expect(named(h, from, "motorist_session_lease_acquire_v2")).toHaveLength(1);
    expect(named(h, from, "motorist_stage_transition_v1")).toHaveLength(0);
    expect(leg(h, call.sessionId, callee)).toEqual(before);
  });

  it("is still rewritten under the lease while the switch is off", async () => {
    const h = harness({ internal_lean_path: true });
    const { call, callee } = await talkingColleague(h);
    await h.legEvent(callee, "call.bridged");
    const from = h.db.log.length;

    const result = await redeliver(h, call.sessionId, callee);

    expect(result.outcome).toBe("processed");
    expect(named(h, from, "motorist_session_lease_acquire_v2")).toHaveLength(1);
    expect(named(h, from, "motorist_stage_transition_v1")).toHaveLength(1);
  });

  it("is not a duplicate once the leg is held", async () => {
    const h = harness();
    const { call, callee } = await talkingColleague(h);
    await h.legEvent(callee, "call.bridged");
    h.db.update("motorist_call_legs", { state: "held" }, row => row.telnyx_call_control_id === callee);
    const from = h.db.log.length;

    const result = await redeliver(h, call.sessionId, callee);

    // The reducer decides, under the lease, exactly as without the switch.
    expect(named(h, from, "motorist_session_lease_acquire_v2")).toHaveLength(1);
    expect(result.notes).not.toContain("lease-free");
  });
});
