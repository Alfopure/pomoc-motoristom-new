import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultAnnouncementConfig } from "@/lib/telephony/announcements";
import { CONNECTION_ID, createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { callColleague, createRateLimiter, hangupCall, startOutboundCall, type CallActionDeps, type CallActor } from "../call-actions";
import { readContactHistory } from "../contact-proof";
import { loadActiveCalls } from "../active-calls";
import { buildPhoneBarModel, type ActiveCallsPayload } from "@/lib/telephony/active-calls-model";
import { defaultLatencyFlags, type LatencyFlags } from "../latency-flags";
import { runPendingEffectRecovery } from "../cron-jobs";
import { setPresence } from "../presence-service";
import { effectsDeps, loadRoutingContext } from "../session-runner";
import { cancelRevokedOffers } from "./cancelled-offers";
import { createTelnyxClient, TelnyxCommandError } from "../telnyx/client";
import { decodeClientState, encodeClientState } from "../telnyx/client-state";
import { readPendingEffects } from "./continuation";
import { isAlreadyBridgedRefusal } from "./effects";
import { buildTelnyxEnvelope } from "./events";
import { planInitialCall } from "./transitions";
import { readMeta, type AppEvent, type DialCommand, type SessionRow } from "./types";

/**
 * Call-speed S6: the far end is dialled in the startup entry, right after the
 * operator's own leg (S6.1), and the call connects on provider evidence only
 * (S6.2) — whichever leg answers first and whatever order the events arrive in.
 * There is no Telnyx evidence yet for a far end answering while the own leg
 * still rings (TEST spike S6.0/1), so every outcome must end well:
 *  (A) Telnyx completes the bridge itself once the own leg answers;
 *  (B) nothing is bridged and both legs stay up: the own answer bridges them,
 *      and a 422 "already bridged" counts as that bridge;
 *  (C) Telnyx hangs the far leg up: the call ends, not as an answered call.
 * The fake provider models `bridge_on_answer` as (A): `physical.connected`.
 */

const actor: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana Dispečerka" };
const ALL = { outbound: { web: true, mobile: true }, internal: { web: true, mobile: true } };
const NONE = { outbound: { web: false, mobile: false }, internal: { web: false, mobile: false } };
const ALREADY_BRIDGED = () => new TelnyxCommandError({ code: "90034", status: 422, detail: "Calls are already bridged" });

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

type World = { h: TelephonyHarness; deps: CallActionDeps; releases: Array<{ sessionId: unknown; profileId: unknown; applied: boolean }> };

function world(flags: Partial<LatencyFlags> = {}, options: { native?: boolean } = {}): World {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  if (options.native) {
    for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
      VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
      APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
  }
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), start_fast_path: true, concurrent_dial: ALL, ...flags };
  if (options.native) h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: PROFILES.o2, environment: "development",
    sip_username: "native-colleague", device_session_id: "00000000-0000-4000-8000-000000009903", device_seen_at: h.now().toISOString(), registration_state: "registered" }]);
  const releases: World["releases"] = [];
  const transition = h.db.rpcHandlers.get("motorist_presence_transition_v1")!;
  h.db.registerRpc("motorist_presence_transition_v1", async (args, db) => {
    const result = await transition(args, db) as { applied: boolean };
    if (args.p_action === "release") releases.push({ sessionId: args.p_session_id, profileId: args.p_profile_id, applied: result.applied });
    return result;
  });
  return { h, deps: { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) }, releases };
}

const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const meta = (t: World, sessionId: string) => readMeta(t.h.session(sessionId) as SessionRow);
const released = (t: World, sessionId: string, profileId: string) => t.releases.filter(row => row.sessionId === sessionId && row.profileId === profileId && row.applied).length;
const hungUp = (t: World, id: string) => t.h.telnyx.of("hangup").some(command => command.params.callControlId === id);

async function outbound(t: World, n = 9001) {
  const call = await startOutboundCall(t.deps, actor, { to: NUMBERS.customer, requestId: requestId(n) });
  const far = t.h.legs(call.sessionId).find(leg => leg.role === "customer");
  return { ...call, own: call.operatorLegCallControlId, far: far ? String(far.telnyx_call_control_id) : "" };
}

async function colleague(t: World, n = 9002) {
  const call = await callColleague(t.deps, actor, { targetProfileId: PROFILES.o2, requestId: requestId(n) });
  const callees = t.h.legs(call.sessionId).filter(leg => leg.profile_id === PROFILES.o2);
  return { ...call, own: call.operatorLegCallControlId, callees: callees.map(leg => String(leg.telnyx_call_control_id)), far: String(callees[0]?.telnyx_call_control_id ?? "") };
}

/**
 * Provider answer first (it may connect a pre-armed pair), then its webhook.
 * Each answer happens a moment after the previous one, so the provider's
 * answer times follow the order a test answers in.
 */
async function answer(t: World, id: string, extra: Record<string, unknown> = {}) {
  t.h.advance(300);
  t.h.telnyx.physical.answered(id);
  return t.h.legEvent(id, "call.answered", extra);
}

/** A provider event that occurred at `occurredAt` and is delivered now: webhooks do not arrive in provider order. */
function eventAt(t: World, id: string, type: string, occurredAt: string, extra: Record<string, unknown> = {}) {
  const leg = t.h.db.find("motorist_call_legs", row => row.telnyx_call_control_id === id)!;
  const session = t.h.session(String(leg.session_id));
  return t.h.process(buildTelnyxEnvelope({ id: t.h.nextEventId(), type, occurredAt, payload: { connection_id: CONNECTION_ID, call_control_id: id,
    call_leg_id: leg.telnyx_call_leg_id ?? `leg-${id}`, call_session_id: session.telnyx_session_id ?? `tsess-${session.id}`,
    client_state: encodeClientState(t.h.clientStateOf(id)), from: leg.from_number, to: leg.to_number, ...extra } }));
}
const later = (t: World, ms: number) => new Date(t.h.now().getTime() + ms).toISOString();

describe("S6.1 the far end is dialled in the startup entry", () => {
  it("dials the customer right after the own leg, linked to it, with the frozen own-leg timeout", async () => {
    const t = world({ own_leg_timeout_secs_concurrent: 15 });
    const call = await outbound(t);
    const [own, far] = t.h.telnyx.of("dial");
    expect(t.h.telnyx.of("dial")).toHaveLength(2);
    expect(own.params).toMatchObject({ to: "sip:gencred001@sip.telnyx.com", timeoutSecs: 15, customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }] });
    expect(far.params).toMatchObject({ to: NUMBERS.customer, linkTo: call.own, bridgeOnAnswer: true, preventDoubleBridge: true,
      extra: { park_after_unbridge: "self" }, timeoutSecs: 45 });
    expect(decodeClientState(String(far.params.clientState))).toMatchObject({ role: "customer", intent: expect.stringMatching(/^ct:/) });
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "ringing", writer_contract: 2 });
    expect(meta(t, call.sessionId)).toMatchObject({
      start_mode: { concurrent: true, ownLegTimeoutSecs: 15, origin: "web" },
      far_end: { commandId: far.params.commandId, mode: "concurrent", dialedAt: expect.any(String) },
      outbound_auto_bridge: { commandId: far.params.commandId, operatorControlId: null }, outbound_audio_gate: true, ring: { mode: "outbound" },
    });
    // One entry, both commands done, nothing left for cron.
    expect(readPendingEffects(t.h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "outbound" });
    // The customer dial is a callback contact intent from the start, bound to the own leg once it exists.
    expect(readContactHistory(t.h.session(call.sessionId) as SessionRow).pendingDials).toEqual([
      expect.objectContaining({ id: far.params.commandId, operatorControlId: "", operatorDialCommandId: own.params.commandId, operatorProfileId: actor.profileId })]);
  });

  it("keeps today's sequential start with the switch off, and for a start that cannot connect directly", async () => {
    const off = world({ concurrent_dial: NONE });
    const sequential = await outbound(off);
    expect(off.h.telnyx.of("dial")).toHaveLength(1);
    expect(off.h.telnyx.of("dial")[0].params.timeoutSecs).toBe(30);
    expect(off.h.session(sequential.sessionId).state).toBe("received");
    expect(meta(off, sequential.sessionId)).toMatchObject({ start_mode: { concurrent: false, ownLegTimeoutSecs: 30 } });
    expect(meta(off, sequential.sessionId).far_end).toBeUndefined();

    // Start announcements (and with them any recording) keep the notice gate: sequential.
    const announced = world();
    announced.h.db.update("motorist_telephony_lines", { metadata: { announcements: { ...defaultAnnouncementConfig(), outboundStartAnnouncements: true } } },
      row => row.id === LINES.allianz);
    const gated = await outbound(announced);
    expect(announced.h.telnyx.of("dial")).toHaveLength(1);
    expect(meta(announced, gated.sessionId)).toMatchObject({ start_mode: { concurrent: false, ownLegTimeoutSecs: 30 } });

    // The switch is per direction (and origin, `latency-flags.test.ts`): outbound on says nothing about a colleague call.
    const scoped = world({ concurrent_dial: { ...NONE, outbound: { web: true, mobile: false } } });
    const internal = await colleague(scoped, 9010);
    expect(scoped.h.telnyx.of("dial")).toHaveLength(1);
    expect(meta(scoped, internal.sessionId)).toMatchObject({ start_mode: { concurrent: false, origin: "web" } });
  });

  it("dials the colleague with the caller's own leg, auto-bridged when frozen so", async () => {
    const t = world({ internal_auto_bridge: true });
    const call = await colleague(t);
    const [own, far] = t.h.telnyx.of("dial");
    expect(far.params).toMatchObject({ to: "sip:gencred002@sip.telnyx.com", linkTo: call.own, bridgeOnAnswer: true, preventDoubleBridge: true,
      extra: { park_after_unbridge: "self" }, timeoutSecs: 30, customHeaders: [{ name: "X-PM-Colleague-Call", value: "1" }], fromDisplayName: "Jana Dispecerka" });
    expect(own.params.timeoutSecs).toBe(12);
    expect(meta(t, call.sessionId)).toMatchObject({ start_mode: { concurrent: true, autoBridge: true }, far_end: { mode: "concurrent", commandId: far.params.commandId },
      internal_auto_bridge: { commandIds: [far.params.commandId] }, ring: { mode: "internal" } });
    expect(t.h.session(call.sessionId).state).toBe("ringing");
    // The caller shows "Vytáčam" from the start; the colleague's phone rings.
    expect(t.h.presence(PROFILES.o2)).toMatchObject({ status: "ringing", current_session_id: call.sessionId });
  });

  it("freezes the mode: a concurrent session stays concurrent after the switch is turned off, and the reverse", async () => {
    const t = world();
    const concurrent = await outbound(t, 9011);
    t.h.deps.latencyFlags = { ...defaultLatencyFlags(), start_fast_path: true, concurrent_dial: NONE };
    await answer(t, concurrent.own);
    // No second customer dial on the own answer: the far end was dialled at the start.
    expect(t.h.telnyx.of("dial").filter(dial => dial.params.to === NUMBERS.customer)).toHaveLength(1);
    await answer(t, concurrent.far);
    expect(t.h.session(concurrent.sessionId).state).toBe("talking");

    const s = world({ concurrent_dial: NONE });
    const sequential = await outbound(s, 9012);
    s.h.deps.latencyFlags = { ...defaultLatencyFlags(), start_fast_path: true, concurrent_dial: ALL };
    expect(s.h.telnyx.of("dial")).toHaveLength(1);
    await answer(s, sequential.own);
    // Dialled on the own answer, the sequential way, never planned as concurrent later.
    expect(s.h.telnyx.of("dial")).toHaveLength(2);
    expect(meta(s, sequential.sessionId).far_end).toBeUndefined();
    expect(meta(s, sequential.sessionId).start_mode).toMatchObject({ concurrent: false });
  });

  it("falls back to the sequential start when a session frozen concurrent cannot dial so, leaving start_mode as created", async () => {
    const t = world();
    const call = await outbound(t, 9013);
    const row = t.h.session(call.sessionId) as SessionRow;
    expect(readMeta(row).start_mode).toMatchObject({ concurrent: true, ownLegTimeoutSecs: 12 });
    // A callback start never dials concurrently, whatever was frozen.
    const session = { ...row, metadata: { ...readMeta(row), callbackRequestId: "00000000-0000-4000-8000-000000009013" } } as SessionRow;
    const ownDial: DialCommand = { kind: "dial", commandId: "initial-own", to: "sip:gencred001@sip.telnyx.com", from: NUMBERS.allianz, role: "operator",
      profileId: actor.profileId, externalNumber: null, clientState: t.h.clientStateOf(call.own), linkTo: null, timeoutSecs: 30 };
    const event: AppEvent = { kind: "app", type: "sweep", id: "startup", actorProfileId: actor.profileId, occurredAt: t.h.now().toISOString() };
    const plan = planInitialCall(session, await loadRoutingContext(t.h.deps, session), event, { ownDial });
    // One own dial with its sequential timeout, and no far end planned.
    expect(plan.commands).toEqual([ownDial]);
    // `start_mode` is written once, at creation (S5 pins the API region in it):
    // the missing `far_end` is what records the sequential run.
    expect(plan.next.session.metadata).toBeUndefined();
  });

  it("uses the 422 rule only for an already-bridged refusal, never for a call that is gone", () => {
    expect(isAlreadyBridgedRefusal(ALREADY_BRIDGED())).toBe(true);
    expect(isAlreadyBridgedRefusal(new TelnyxCommandError({ code: "90034", status: 422, title: "Call already in a bridge" }))).toBe(true);
    expect(isAlreadyBridgedRefusal(new TelnyxCommandError({ code: "90018", status: 422, detail: "Call has already ended" }))).toBe(false);
    expect(isAlreadyBridgedRefusal(new TelnyxCommandError({ code: "90053", status: 422, detail: "Call is not answered yet" }))).toBe(false);
    expect(isAlreadyBridgedRefusal(new TelnyxCommandError({ code: "x", status: 409, detail: "already bridged" }))).toBe(false);
  });
});

describe("S6.2 decision table: outbound", () => {
  it("connects the ordinary order (own leg first) at the customer's answer, with no bridge", async () => {
    const t = world();
    const call = await outbound(t);
    await answer(t, call.own);
    expect(t.h.session(call.sessionId).state).toBe("ringing");
    await answer(t, call.far);
    expect(t.h.telnyx.physical.connected(call.own, call.far)).toBe(true);
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "talking", answered_at: expect.any(String) });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "answered" });
    expect(t.h.telnyx.of("bridge")).toHaveLength(0);
    expect(meta(t, call.sessionId).accepted_device_legs).toEqual({ [actor.profileId]: call.own });
  });

  it("(A) customer first, Telnyx completes the bridge at the own answer: no bridge from us, talking from the bridged evidence", async () => {
    const t = world();
    const call = await outbound(t);
    await answer(t, call.far);
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "ringing", answered_at: null });
    expect(meta(t, call.sessionId).far_end).toMatchObject({ answeredAt: expect.any(String) });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "outbound" });
    t.h.telnyx.physical.answered(call.own);
    expect(t.h.telnyx.physical.connected(call.own, call.far)).toBe(true);
    // The own leg's answer is deferred behind the bridged events.
    await t.h.legEvent(call.far, "call.bridged");
    expect(t.h.session(call.sessionId).state).toBe("talking");
    await t.h.legEvent(call.own, "call.bridged");
    await t.h.legEvent(call.own, "call.answered");
    expect(t.h.telnyx.of("bridge")).toHaveLength(0);
    expect(t.h.session(call.sessionId).state).toBe("talking");
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "answered" });
    // The bridged pair proves the contact (callback fulfilment), as for a sequential direct dial.
    expect(readContactHistory(t.h.session(call.sessionId) as SessionRow).proofs).toMatchObject([{ topology: "bridge", customerControlId: call.far, operatorControlId: call.own }]);
  });

  it("(B) customer first, nothing bridged: the own answer bridges, once, in today's direction", async () => {
    const t = world();
    const call = await outbound(t);
    await answer(t, call.far);
    await answer(t, call.own);
    expect(t.h.telnyx.of("bridge").map(command => command.params)).toEqual([expect.objectContaining({ callControlId: call.own, targetCallControlId: call.far, parkAfterUnbridge: "self" })]);
    expect(t.h.session(call.sessionId).state).toBe("talking");
    // A duplicate own answer sends no second bridge.
    await t.h.legEvent(call.own, "call.answered", {}, "duplicate-own-answer");
    expect(t.h.telnyx.of("bridge")).toHaveLength(1);
    // Its bridged events, after the bridge and with the client state the bridge
    // put on the own leg, prove the contact of the customer dial (callbacks).
    t.h.advance(400);
    await t.h.legEvent(call.own, "call.bridged", { client_state: t.h.telnyx.of("bridge")[0].params.clientState });
    await t.h.legEvent(call.far, "call.bridged");
    const farDial = t.h.telnyx.of("dial")[1].params.commandId;
    expect(readContactHistory(t.h.session(call.sessionId) as SessionRow).proofs).toMatchObject([{ operationId: farDial, customerControlId: call.far, operatorControlId: call.own }]);
  });

  it("(B) bridges when the customer answered first at the provider, even if the own answer is processed first", async () => {
    const t = world();
    const call = await outbound(t);
    t.h.telnyx.physical.answered(call.far);
    t.h.telnyx.physical.answered(call.own);
    const farAt = later(t, 100), ownAt = later(t, 400);
    t.h.advance(600);
    // The own answer's webhook overtakes the customer's.
    await eventAt(t, call.own, "call.answered", ownAt);
    expect(t.h.session(call.sessionId).state).toBe("ringing");
    expect(t.h.telnyx.of("bridge")).toHaveLength(0);
    await eventAt(t, call.far, "call.answered", farAt);
    expect(t.h.telnyx.of("bridge").map(command => command.params)).toEqual([expect.objectContaining({ callControlId: call.own, targetCallControlId: call.far })]);
    expect(t.h.session(call.sessionId).state).toBe("talking");
  });

  it("sends no bridge when the own leg answered first at the provider, whatever order the webhooks arrive in", async () => {
    const t = world();
    const call = await outbound(t);
    t.h.telnyx.physical.answered(call.own);
    t.h.telnyx.physical.answered(call.far);
    const ownAt = later(t, 100), farAt = later(t, 400);
    t.h.advance(600);
    await eventAt(t, call.far, "call.answered", farAt);
    expect(t.h.session(call.sessionId).state).toBe("ringing");
    await eventAt(t, call.own, "call.answered", ownAt);
    // Telnyx bridged at the customer's answer, the own leg being up (`bridge_on_answer`).
    expect(t.h.telnyx.of("bridge")).toHaveLength(0);
    expect(t.h.session(call.sessionId).state).toBe("talking");
  });

  it("(A/B) counts Telnyx's 422 \"already bridged\" as the connection, without compensation or incident", async () => {
    const t = world();
    const call = await outbound(t);
    await answer(t, call.far);
    t.h.telnyx.failNext("bridge", ALREADY_BRIDGED());
    const result = await answer(t, call.own);
    expect(result.outcome).toBe("processed");
    expect(t.h.session(call.sessionId).state).toBe("talking");
    expect(hungUp(t, call.own) || hungUp(t, call.far)).toBe(false);
    expect(t.h.rows("motorist_job_incidents").filter(row => row.status === "open")).toEqual([]);
    expect(readPendingEffects(t.h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "answered" });
  });

  it("(B) any other bridge refusal hangs up both legs and ends the call as bridge_failed", async () => {
    const t = world();
    const call = await outbound(t);
    await answer(t, call.far);
    t.h.telnyx.failNext("bridge", new TelnyxCommandError({ code: "90053", status: 422, detail: "Call is not answered yet" }));
    await answer(t, call.own);
    expect(hungUp(t, call.own)).toBe(true);
    expect(hungUp(t, call.far)).toBe(true);
    // Never connected: neither the session nor the history says answered.
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: expect.any(String), answered_at: null });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "bridge_failed", answered_at: null });
    for (const id of [call.own, call.far]) await t.h.legEvent(id, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    expect(released(t, call.sessionId, actor.profileId)).toBe(1);
  });

  it("(C) the provider hangs the answered customer up: the call ends, not answered, presence released once", async () => {
    const t = world();
    const call = await outbound(t);
    await answer(t, call.far);
    await t.h.legEvent(call.far, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "unknown" });
    expect(hungUp(t, call.own)).toBe(true);
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "ended", answered_at: null });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "bridge_failed", answered_at: null });
    // The own leg's late events change nothing.
    await answer(t, call.own);
    await t.h.legEvent(call.own, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(t.h.telnyx.of("bridge")).toHaveLength(0);
    expect(t.h.session(call.sessionId).state).toBe("ended");
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    expect(released(t, call.sessionId, actor.profileId)).toBe(1);
  });

  it("ends both legs at the frozen own-leg timeout when the operator's phone never answers, releasing the operator once", async () => {
    const t = world();
    const call = await outbound(t);
    await answer(t, call.far);
    // Telnyx ends the unanswered own leg after `timeout_secs` (12 s).
    t.h.advance(12_000);
    await t.h.legEvent(call.own, "call.hangup", { hangup_cause: "timeout", sip_hangup_cause: "487" });
    expect(hungUp(t, call.far)).toBe(true);
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "ended", answered_at: null });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "operator_leg_unavailable" });
    await t.h.legEvent(call.far, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    expect(released(t, call.sessionId, actor.profileId)).toBe(1);
    expect(t.h.telnyx.physical.connected(call.own, call.far)).toBe(false);
  });

  it("lets the operator cancel while both legs ring", async () => {
    const t = world();
    const call = await outbound(t);
    await hangupCall(t.deps, actor, call.sessionId);
    expect(hungUp(t, call.own)).toBe(true);
    expect(hungUp(t, call.far)).toBe(true);
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "ended" });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "operator_hangup" });
    // A late customer answer meets an ended call and is hung up, never connected.
    t.h.telnyx.physical.answered(call.far);
    await t.h.legEvent(call.far, "call.answered");
    expect(t.h.telnyx.physical.connected(call.own, call.far)).toBe(false);
    for (const id of [call.own, call.far]) await t.h.legEvent(id, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    expect(released(t, call.sessionId, actor.profileId)).toBe(1);
  });

  it("records an answered call when the customer hangs up after talking was reached", async () => {
    const t = world();
    const call = await outbound(t);
    await answer(t, call.far);
    await answer(t, call.own);
    expect(t.h.session(call.sessionId).state).toBe("talking");
    await t.h.legEvent(call.far, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "caller_hangup", answered_at: expect.any(String) });
  });

  it("fails the call when the provider refuses the customer dial, hanging up the own leg and releasing the operator", async () => {
    const t = world();
    // The own leg goes through; the next dial (the customer's) is refused.
    const dial = t.h.telnyx.client.dial.bind(t.h.telnyx.client);
    let dials = 0;
    vi.spyOn(t.h.telnyx.client, "dial").mockImplementation(async params => {
      if (++dials === 2) throw new TelnyxCommandError({ code: "10010", status: 422, detail: "Invalid destination" });
      return dial(params);
    });
    const call = await startOutboundCall(t.deps, actor, { to: NUMBERS.customer, requestId: requestId(9020) }).catch(error => error as Error);
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    const own = t.h.legs(session.id).find(leg => leg.role === "operator")!;
    expect(hungUp(t, String(own.telnyx_call_control_id))).toBe(true);
    expect(session).toMatchObject({ state: "failed", ended_at: expect.any(String) });
    expect(t.h.call(session.id)).toMatchObject({ status: "failed", end_reason: "dial_failed" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    expect(released(t, session.id, actor.profileId)).toBe(1);
    // The client is told the call ended, not given a leg to answer.
    expect(call).toMatchObject({ status: 409, code: "initial_call_ended" });
  });

  it("answers early with the own leg when the customer dial's outcome is unknown, and adopts that dial on its own provider event", async () => {
    const t = world({ start_early_response: true });
    const dial = t.h.telnyx.client.dial.bind(t.h.telnyx.client);
    let dials = 0;
    // The customer dial reaches the provider but its response is lost.
    vi.spyOn(t.h.telnyx.client, "dial").mockImplementation(async params => {
      if (++dials === 2) t.h.telnyx.loseNextResponse("dial");
      return dial(params);
    });
    let early: string | null = null;
    const call = await startOutboundCall(t.deps, actor, { to: NUMBERS.customer, requestId: requestId(9021) },
      (result) => { early = result.operatorLegCallControlId; });
    // The route answered after the own dial (S2.3); the far dial ran behind it.
    expect(early).toBe(call.operatorLegCallControlId);
    expect(t.h.legs(call.sessionId).some(leg => leg.role === "customer")).toBe(false);
    const entries = readPendingEffects(t.h.session(call.sessionId) as SessionRow).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(`initial:${t.h.telnyx.of("dial")[0].params.commandId}`);
    // An unknown outcome is never redialled blindly: the own leg's events do not send it again.
    await t.h.legEvent(call.operatorLegCallControlId, "call.initiated");
    await answer(t, call.operatorLegCallControlId);
    const customerDials = () => t.h.telnyx.of("dial").filter(item => item.params.to === NUMBERS.customer);
    expect(customerDials()).toHaveLength(1);
    expect(t.h.session(call.sessionId).state).toBe("ringing");
    // The customer's own provider event proves the dial; the entry adopts that exact leg.
    const lost = customerDials()[0];
    const far = [...t.h.telnyx.physical.legs.keys()].find(id => id !== call.operatorLegCallControlId)!;
    await t.h.process(t.h.envelope("call.initiated", { call_control_id: far, call_leg_id: `leg-${far}`, client_state: lost.params.clientState,
      to: NUMBERS.customer, from: lost.params.from, direction: "outgoing" }));
    expect(customerDials().every(item => item.params.commandId === lost.params.commandId)).toBe(true);
    expect(t.h.telnyx.of("dial").filter(item => String(item.params.to).startsWith("sip:"))).toHaveLength(1);
    expect(t.h.telnyx.physical.legs.size).toBe(2);
    expect(t.h.legs(call.sessionId).find(leg => leg.role === "customer")).toMatchObject({ telnyx_call_control_id: far });
    await answer(t, far);
    expect(t.h.session(call.sessionId).state).toBe("talking");
    expect(readPendingEffects(t.h.session(call.sessionId) as SessionRow).entries).toEqual([]);
  });

  it("returns the same leg to an identical retry of a two-command start, with no new dial (real wire adapter and journal)", async () => {
    const t = world();
    let posts = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method !== "POST" || !path.endsWith("/calls")) throw new Error(`unexpected ${init?.method} ${path}`);
      const id = ++posts === 1 ? "wire-own-leg" : "wire-customer-leg";
      return Response.json({ data: { call_control_id: id, call_leg_id: `leg-${id}`, call_session_id: "wire-session" } });
    });
    const telnyx = createTelnyxClient({ config: t.h.deps.config, fetch: fetch as typeof globalThis.fetch, liveGate: { callsEnabled: true, smsEnabled: false } });
    const deps = { ...t.deps, telnyx };
    const first = await startOutboundCall(deps, actor, { to: NUMBERS.customer, requestId: requestId(9022) });
    expect(first.operatorLegCallControlId).toBe("wire-own-leg");
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies[1]).toMatchObject({ to: NUMBERS.customer, link_to: "wire-own-leg", bridge_on_answer: true, prevent_double_bridge: true, park_after_unbridge: "self" });
    expect(t.h.rows("motorist_provider_commands").filter(row => row.path === "/calls")).toEqual([
      expect.objectContaining({ outcome: "accepted" }), expect.objectContaining({ outcome: "accepted", request_payload: expect.objectContaining({ link_to: "wire-own-leg" }) })]);
    const again = await startOutboundCall(deps, actor, { to: NUMBERS.customer, requestId: requestId(9022) });
    expect(again.operatorLegCallControlId).toBe("wire-own-leg");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retires the customer dial a termination refuses after the own dial, leaving the own leg to the termination", async () => {
    const t = world();
    const prepare = t.h.db.rpcHandlers.get("motorist_provider_command_prepare_v2")!;
    let calls = 0;
    t.h.db.registerRpc("motorist_provider_command_prepare_v2", async (args, db) => {
      // The operator hangs up between the two dials of the entry.
      if (args.p_path === "/calls" && ++calls === 2) await db.rpcHandlers.get("motorist_session_terminate_v2")!({ p_organization_id: ORG, p_session_id: args.p_session_id }, db);
      return prepare(args, db);
    });
    const call = await startOutboundCall(t.deps, actor, { to: NUMBERS.customer, requestId: requestId(9023) }).catch(error => error as Error);
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    expect(t.h.telnyx.of("dial")).toHaveLength(1);
    expect(readPendingEffects(session).entries).toEqual([]);
    // Not cancelled-before-dial: the own leg exists, and the termination ends it.
    expect(t.h.call(session.id)?.end_reason ?? null).not.toBe("cancelled_before_dial");
    void call;
    const own = String(t.h.legs(session.id).find(leg => leg.role === "operator")!.telnyx_call_control_id);
    await t.h.legEvent(own, "call.initiated");
    expect(hungUp(t, own)).toBe(true);
    expect(t.h.session(session.id)).toMatchObject({ state: "ended" });
    await t.h.legEvent(own, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    expect(released(t, session.id, actor.profileId)).toBe(1);
  });
});

describe("S6.2/S6.3 colleague calls", () => {
  it("connects with no bridge when the caller answered first and Telnyx bridges the colleague at answer", async () => {
    const t = world({ internal_auto_bridge: true });
    const call = await colleague(t);
    await answer(t, call.own);
    expect(t.h.session(call.sessionId).state).toBe("ringing");
    await answer(t, call.far);
    expect(t.h.telnyx.physical.connected(call.own, call.far)).toBe(true);
    expect(t.h.session(call.sessionId).state).toBe("talking");
    expect(t.h.telnyx.of("bridge")).toHaveLength(0);
    expect(t.h.presence(PROFILES.o2)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
  });

  it("auto-bridges a sequential colleague call too: dialled at the caller's answer with bridge_on_answer, connected with no bridge", async () => {
    const t = world({ internal_auto_bridge: true, concurrent_dial: NONE });
    const call = await colleague(t, 9040);
    expect(t.h.telnyx.of("dial")).toHaveLength(1);
    await answer(t, call.own);
    const callee = String(t.h.openLegFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
    expect(t.h.telnyx.of("dial")[1].params).toMatchObject({ linkTo: call.own, bridgeOnAnswer: true, preventDoubleBridge: true, extra: { park_after_unbridge: "self" } });
    expect(meta(t, call.sessionId)).toMatchObject({ start_mode: { concurrent: false, autoBridge: true }, internal_auto_bridge: { commandIds: [t.h.telnyx.of("dial")[1].params.commandId] } });
    expect(meta(t, call.sessionId).far_end).toBeUndefined();
    await answer(t, callee);
    expect(t.h.telnyx.physical.connected(call.own, callee)).toBe(true);
    expect(t.h.telnyx.of("bridge")).toHaveLength(0);
    expect(t.h.session(call.sessionId).state).toBe("talking");
  });

  it("keeps today's explicit bridge without the auto-bridge, sent once the caller has answered", async () => {
    const t = world({ internal_auto_bridge: false });
    const call = await colleague(t);
    expect(t.h.telnyx.of("dial")[1].params.bridgeOnAnswer).toBeUndefined();
    await answer(t, call.own);
    await answer(t, call.far);
    expect(t.h.telnyx.of("bridge").map(command => command.params)).toEqual([expect.objectContaining({ callControlId: call.own, targetCallControlId: call.far })]);
    expect(t.h.session(call.sessionId).state).toBe("talking");
  });

  it.each([true, false])("waits for the caller when the colleague answers first, then bridges on the caller's answer (auto-bridge=%s)", async (autoBridge) => {
    const t = world({ internal_auto_bridge: autoBridge });
    const call = await colleague(t);
    await answer(t, call.far);
    // Accepted and reserved, but not connected: the colleague's bar shows "Spájam…".
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "ringing", answered_at: null });
    expect(t.h.presence(PROFILES.o2)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    expect(meta(t, call.sessionId)).toMatchObject({ far_end: { answeredAt: expect.any(String) }, accepted_device_legs: { [PROFILES.o2]: call.far } });
    expect(t.h.telnyx.of("bridge")).toHaveLength(0);
    if (autoBridge) t.h.telnyx.failNext("bridge", ALREADY_BRIDGED());
    await answer(t, call.own);
    expect(t.h.telnyx.of("bridge").map(command => command.params)).toEqual([expect.objectContaining({ callControlId: call.own, targetCallControlId: call.far, parkAfterUnbridge: "self" })]);
    expect(t.h.session(call.sessionId).state).toBe("talking");
    expect(t.h.rows("motorist_job_incidents").filter(row => row.status === "open")).toEqual([]);
  });

  it("tells both browsers the call is auto-bridged; the colleague who answered first sees it connecting, with no new state", async () => {
    const t = world({ internal_auto_bridge: true });
    const call = await colleague(t);
    await answer(t, call.far);
    const [callerView, calleeView] = await Promise.all([PROFILES.o1, PROFILES.o2].map(profileId =>
      loadActiveCalls({ ...t.h.deps, configured: true }, { profileId, canManageAssignments: false })));
    for (const view of [callerView, calleeView]) expect(view.calls).toEqual([expect.objectContaining({ sessionId: call.sessionId, state: "ringing", autoBridge: true })]);
    const callee = buildPhoneBarModel(calleeView as unknown as ActiveCallsPayload);
    expect(callee.active).toMatchObject({ sessionId: call.sessionId, connecting: true, autoBridge: true });
    expect(buildPhoneBarModel(callerView as unknown as ActiveCallsPayload).active).not.toHaveProperty("connecting");
  });

  it("connects on the colleague's bridged evidence even before the caller's answer is processed", async () => {
    const t = world({ internal_auto_bridge: true });
    const call = await colleague(t);
    await answer(t, call.far);
    t.h.telnyx.physical.answered(call.own);
    await t.h.legEvent(call.far, "call.bridged");
    expect(t.h.session(call.sessionId).state).toBe("talking");
    await t.h.legEvent(call.own, "call.answered");
    expect(t.h.telnyx.of("bridge")).toHaveLength(0);
    expect(t.h.session(call.sessionId).state).toBe("talking");
  });

  it("(C) ends the call when the provider hangs up the colleague who answered first, releasing both people once", async () => {
    const t = world({ internal_auto_bridge: true });
    const call = await colleague(t);
    await answer(t, call.far);
    await t.h.legEvent(call.far, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(hungUp(t, call.own)).toBe(true);
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "ended", answered_at: null });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "bridge_failed" });
    await t.h.legEvent(call.own, "call.hangup", { hangup_cause: "normal_clearing" });
    for (const profileId of [PROFILES.o1, PROFILES.o2]) {
      expect(t.h.presence(profileId)).toMatchObject({ status: "available", current_session_id: null });
      expect(released(t, call.sessionId, profileId)).toBe(1);
    }
  });

  it("ends both at the caller's own-leg timeout while the colleague rings", async () => {
    const t = world({ internal_auto_bridge: true });
    const call = await colleague(t);
    await t.h.legEvent(call.own, "call.hangup", { hangup_cause: "timeout" });
    expect(hungUp(t, call.far)).toBe(true);
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "operator_leg_unavailable" });
    await t.h.legEvent(call.far, "call.hangup", { hangup_cause: "originator_cancel" });
    expect(t.h.session(call.sessionId).state).toBe("ended");
    for (const profileId of [PROFILES.o1, PROFILES.o2]) expect(t.h.presence(profileId)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("rings both colleague endpoints with the caller's leg; the server picks one winner and bridges it, the sibling is hung up", async () => {
    const t = world({ internal_auto_bridge: true }, { native: true });
    const call = await colleague(t);
    expect(call.callees).toHaveLength(2);
    const fanout = t.h.telnyx.of("dial").slice(1);
    expect(fanout.map(dial => dial.params)).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: "sip:gencred002@sip.telnyx.com", linkTo: call.own }),
      expect.objectContaining({ to: "sip:native-colleague@sip.telnyx.com", linkTo: call.own }),
    ]));
    // With two endpoints Telnyx could bridge one while the server accepts the
    // other, so no auto-bridge: the server's winner gets the explicit bridge.
    expect(fanout.every(dial => dial.params.bridgeOnAnswer === undefined)).toBe(true);
    expect(meta(t, call.sessionId)).toMatchObject({ far_end: { commandId: "ring_fanout:0" }, start_mode: { concurrent: true, autoBridge: false } });
    expect(meta(t, call.sessionId).internal_auto_bridge).toBeUndefined();
    // The browser is told what the dial carries, not what the switch asked for.
    const view = await loadActiveCalls({ ...t.h.deps, configured: true }, { profileId: PROFILES.o1, canManageAssignments: false });
    expect(view.calls).toEqual([expect.objectContaining({ sessionId: call.sessionId })]);
    expect(view.calls[0]).not.toHaveProperty("autoBridge");
    const [winner, loser] = call.callees;
    await answer(t, call.own);
    await answer(t, winner);
    expect(hungUp(t, loser)).toBe(true);
    // Both answering within a moment: the loser's late answer is hung up, never bridged.
    await answer(t, loser);
    expect(t.h.telnyx.of("bridge").map(command => command.params)).toEqual([expect.objectContaining({ callControlId: call.own, targetCallControlId: winner })]);
    expect(t.h.session(call.sessionId).state).toBe("talking");
    expect(meta(t, call.sessionId).accepted_device_legs).toMatchObject({ [PROFILES.o2]: winner });
  });

  it("hangs up the caller when every colleague endpoint is refused", async () => {
    const t = world({ internal_auto_bridge: true }, { native: true });
    const many = t.h.telnyx.client.dialMany.bind(t.h.telnyx.client);
    vi.spyOn(t.h.telnyx.client, "dialMany").mockImplementation(async list => {
      const settled = await many(list);
      return settled.map(() => ({ status: "rejected" as const, reason: new TelnyxCommandError({ code: "10010", status: 422, detail: "refused" }) }));
    });
    const result = await callColleague(t.deps, actor, { targetProfileId: PROFILES.o2, requestId: requestId(9030) }).catch(error => error as Error);
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    const own = String(t.h.legs(session.id).find(leg => leg.profile_id === actor.profileId)!.telnyx_call_control_id);
    expect(hungUp(t, own)).toBe(true);
    expect(session).toMatchObject({ state: "failed" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    void result;
  });

  it("proves the colleague endpoints' TEST destination in the start request, beside the caller's own", async () => {
    const t = world({ start_test_proof_prefetch: true });
    const proofs: string[] = [];
    t.h.telnyx.client.proveSipDestination = (to: string) => { proofs.push(to); return Promise.resolve("proven" as const); };
    await colleague(t);
    expect(proofs).toEqual(["sip:gencred001@sip.telnyx.com", "sip:gencred002@sip.telnyx.com"]);
    const s = world({ start_test_proof_prefetch: true, concurrent_dial: NONE });
    const sequential: string[] = [];
    s.h.telnyx.client.proveSipDestination = (to: string) => { sequential.push(to); return Promise.resolve("proven" as const); };
    await colleague(s, 9031);
    expect(sequential).toEqual(["sip:gencred001@sip.telnyx.com"]);
  });
});

/** Every delivery order of a list (n ≤ 4 here: 24 orders). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}

describe("S6.2 permutations: whatever order the provider events arrive in", () => {
  type Step = "own.answered" | "far.answered" | "own.bridged" | "far.bridged";
  const STEPS: Step[] = ["own.answered", "far.answered", "own.bridged", "far.bridged"];
  const orders = permutations(STEPS).map(order => order.join(" → "));
  const scenarios = ["far end answered first", "own leg answered first"] as const;
  type Scenario = (typeof scenarios)[number];
  const cases = scenarios.flatMap(scenario => orders.map(order => [scenario, order] as const));
  /**
   * The decision follows the provider's answer times, never the delivery
   * order. Only when the far end answered first (outcome B: Telnyx could not
   * bridge to a ringing own leg) does the server send the one explicit bridge,
   * and only if no bridged evidence was processed before both answers; a 422
   * "already bridged" would then count as success. When the own leg answered
   * first Telnyx bridges at the far end's answer (`bridge_on_answer`): none.
   */
  const explicitBridges = (scenario: Scenario, order: string) => {
    if (scenario === "own leg answered first") return 0;
    const at = (step: Step) => order.split(" → ").indexOf(step);
    return Math.max(at("own.answered"), at("far.answered")) < Math.min(at("own.bridged"), at("far.bridged")) ? 1 : 0;
  };
  /** Delivers the four events in `order`, each stamped with its provider time. */
  async function deliver(t: World, call: { own: string; far: string }, scenario: Scenario, order: string) {
    const first = later(t, 100), second = later(t, 400), bridged = later(t, 450);
    const answeredAt = scenario === "far end answered first" ? { far: first, own: second } : { own: first, far: second };
    t.h.advance(600);
    for (const step of order.split(" → ") as Step[]) {
      const [leg, type] = step.split(".") as ["own" | "far", "answered" | "bridged"];
      await eventAt(t, call[leg], `call.${type}`, type === "answered" ? answeredAt[leg] : bridged);
    }
  }

  it.each(cases)("outbound, %s, delivered %s", async (scenario, order) => {
    const t = world();
    const call = await outbound(t, 9100);
    await t.h.legEvent(call.far, "call.initiated");
    t.h.telnyx.physical.answered(call.far);
    t.h.telnyx.physical.answered(call.own);
    await deliver(t, call, scenario, order);
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "talking", answered_at: expect.any(String) });
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "answered" });
    expect(t.h.telnyx.of("bridge")).toHaveLength(explicitBridges(scenario, order));
    expect(t.h.telnyx.of("hangup")).toEqual([]);
    expect(readContactHistory(t.h.session(call.sessionId) as SessionRow).proofs.length).toBeGreaterThanOrEqual(1);
    expect(readPendingEffects(t.h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect(t.h.rows("motorist_job_incidents").filter(row => row.status === "open")).toEqual([]);
    // Then the customer leaves: one release, an answered call in the history.
    await t.h.legEvent(call.far, "call.hangup", { hangup_cause: "normal_clearing" });
    await t.h.legEvent(call.own, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(t.h.session(call.sessionId).state).toBe("ended");
    expect(t.h.call(call.sessionId)).toMatchObject({ status: "ended", answered_at: expect.any(String) });
    expect(t.h.presence(actor.profileId)).toMatchObject({ current_session_id: null });
    expect(released(t, call.sessionId, actor.profileId)).toBeLessThanOrEqual(1);
  });

  it.each(cases)("colleague call (auto-bridge), %s, delivered %s", async (scenario, order) => {
    const t = world({ internal_auto_bridge: true });
    const call = await colleague(t, 9101);
    t.h.telnyx.physical.answered(call.far);
    t.h.telnyx.physical.answered(call.own);
    await deliver(t, call, scenario, order);
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "talking", answered_at: expect.any(String) });
    expect(t.h.telnyx.of("bridge")).toHaveLength(explicitBridges(scenario, order));
    expect(t.h.telnyx.of("hangup")).toEqual([]);
    expect(t.h.presence(PROFILES.o2)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    await t.h.legEvent(call.own, "call.hangup", { hangup_cause: "normal_clearing" });
    await t.h.legEvent(call.far, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(t.h.session(call.sessionId).state).toBe("ended");
    for (const profileId of [PROFILES.o1, PROFILES.o2]) expect(t.h.presence(profileId)).toMatchObject({ status: "available", current_session_id: null });
  });
});

/**
 * PA-04 (`dispatch-pause-boundaries.test.ts`) for the colleague dial a
 * concurrent start sends in its own request: the colleague pauses before the
 * claim, after it, while the provider answer is pending, and after the start.
 */
describe("S6 pause boundaries of a concurrent colleague dial", () => {
  const windows = ["before_authorization", "authorized_before_send", "response_pending", "identity_persisted"] as const;
  const pauseReason = "00000000-0000-4000-8000-000000002501";

  const cases = windows.flatMap(window => [false, true].map(autoBridge => [window, autoBridge] as const));
  it.each(cases)("%s (auto-bridge=%s)", async (window, autoBridge) => {
    const t = world({ internal_auto_bridge: autoBridge });
    let paused = false;
    const pause = async (sessionId: string) => {
      paused = true;
      await setPresence(t.h.deps, { organizationId: ORG, profileId: PROFILES.o2, status: "paused", pauseReasonId: pauseReason });
      await cancelRevokedOffers(effectsDeps(t.h.deps), t.h.session(sessionId) as SessionRow);
    };
    const rpc = t.h.db.rpcHandlers.get("motorist_presence_transition_v1")!;
    t.h.db.registerRpc("motorist_presence_transition_v1", async (args, db) => {
      const colleagueDispatch = args.p_action === "dispatch" && args.p_profile_id === PROFILES.o2 && !paused;
      if (colleagueDispatch && window === "before_authorization") await pause(String(args.p_session_id));
      const result = await rpc(args, db);
      if (colleagueDispatch && window === "authorized_before_send") await pause(String(args.p_session_id));
      return result;
    });
    const dial = t.h.telnyx.client.dial.bind(t.h.telnyx.client);
    vi.spyOn(t.h.telnyx.client, "dial").mockImplementation(async input => {
      const result = await dial(input);
      const state = decodeClientState(input.clientState);
      if (state?.operatorId === PROFILES.o2 && window === "response_pending" && !paused) await pause(state.sid);
      return result;
    });
    const started = await callColleague(t.deps, actor, { targetProfileId: PROFILES.o2, requestId: requestId(9200) }).catch(error => error as Error);
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    if (window === "identity_persisted") await pause(session.id);
    expect(paused).toBe(true);
    const colleagueDials = t.h.telnyx.of("dial").filter(command => decodeClientState(command.params.clientState)?.operatorId === PROFILES.o2);
    const own = String(t.h.legs(session.id).find(leg => leg.profile_id === actor.profileId)!.telnyx_call_control_id);
    if (window === "before_authorization") {
      // Never offered: the start's compensation ends the call and frees the caller.
      expect(colleagueDials).toEqual([]);
      expect(hungUp(t, own)).toBe(true);
      expect(t.h.session(session.id).state).toBe("failed");
      expect(started).toBeInstanceOf(Error);
    } else {
      // Offered with a token the pause revoked: a late answer is hung up, never connected.
      expect(colleagueDials).toHaveLength(1);
      const revoked = decodeClientState(colleagueDials[0].params.clientState)!.offerToken!;
      expect(t.h.session(session.id).presence_cancellations).toHaveProperty(revoked);
      const leg = String(t.h.legs(session.id).find(row => (row.client_state as { offerToken?: string } | null)?.offerToken === revoked)!.telnyx_call_control_id);
      // The revoked leg is hung up as soon as its identity is known, so even
      // an auto-bridged dial (bridge_on_answer) has nothing left to connect.
      expect(t.h.telnyx.physical.legs.get(leg)?.ended).toBe(true);
      t.h.telnyx.physical.answered(own);
      t.h.telnyx.physical.answered(leg);
      expect(t.h.telnyx.physical.connected(own, leg)).toBe(false);
      await t.h.legEvent(leg, "call.answered");
      expect(t.h.telnyx.physical.legs.get(leg)?.ended).toBe(true);
      expect(t.h.telnyx.physical.connected(own, leg)).toBe(false);
    }
    expect(t.h.presence(PROFILES.o2)).toMatchObject({ status: "paused", pause_reason_id: pauseReason, current_session_id: null });
    const count = colleagueDials.length;
    t.h.advance(31_000);
    await runPendingEffectRecovery(t.h.deps);
    expect(t.h.telnyx.of("dial").filter(command => decodeClientState(command.params.clientState)?.operatorId === PROFILES.o2)).toHaveLength(count);
  });
});

describe("S6 cron and recovery", () => {
  it("leaves nothing for cron once both dials are done, and cron never dials again", async () => {
    const t = world({ internal_auto_bridge: true });
    const call = await colleague(t);
    t.h.advance(31_000);
    await runPendingEffectRecovery(t.h.deps);
    expect(t.h.telnyx.of("dial")).toHaveLength(2);
    expect(t.h.session(call.sessionId).state).toBe("ringing");
  });
});
