import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { loadRoutingContext, loadSessionSnapshot } from "./session-runner";
import { DEFAULT_ROUTING_SETTINGS, readMeta, type RoutingContext, type SessionEvent, type SessionRow } from "./state/types";
import { callColleague, createRateLimiter, startOutboundCall } from "./call-actions";
import { defaultLatencyFlags } from "./latency-flags";
import { reduce } from "./state/transitions";
import { parseTelnyxEnvelope } from "./state/events";
import { encodeClientState } from "./telnyx/client-state";

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
  it("uses frozen outbound setup only after initiated, with recording off and the exact own leg", async () => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const call = await startOutboundCall(h.deps, { profileId: PROFILES.o1, role: "dispatcher" }, {
      to: NUMBERS.customer, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const event = parseTelnyxEnvelope(h.envelope("call.answered", {
      call_control_id: call.operatorLegCallControlId, client_state: encodeClientState(h.clientStateOf(call.operatorLegCallControlId)),
    }))!;
    expect((await contextFor(h, call.sessionId, event)).lean).toBeUndefined();
    await h.legEvent(call.operatorLegCallControlId, "call.initiated");
    expect((await contextFor(h, call.sessionId, event)).lean).toBe(true);
    const wrong = { ...event, clientState: { ...event.clientState!, intent: "internal_caller" } };
    expect((await contextFor(h, call.sessionId, wrong)).lean).toBeUndefined();
    const session = h.session(call.sessionId) as SessionRow;
    const meta = readMeta(session);
    h.db.update("motorist_call_sessions", { metadata: { ...meta, recording: { ...meta.recording, policy: { ...meta.recording!.policy, enabled: true } } } }, row => row.id === call.sessionId);
    expect((await contextFor(h, call.sessionId, event)).lean).toBeUndefined();
  });
  it("loads the real organisation leg count for inbound pickup without inbound routing", async () => {
    const h = createTelephonyHarness();
    const { call } = await ringing(h);
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const before = h.db.log.length;
    const context = await loadRoutingContext(h.deps, snapshot.session, {
      kind: "app", type: "pickup", id: "pickup", actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString(),
    }, snapshot.legs);
    expect(context.lean).toBe(true);
    expect(context.activeLegCount).toBe(4);
    expect(h.db.log.slice(before).map(row => row.table).sort()).toEqual(["motorist_call_legs", "motorist_telephony_settings"]);
  });
  it("registers an already dialled operator under the lease without reloading inbound routing", async () => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const { call, operatorControlId } = await ringing(h);
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const event = { ...answered(operatorControlId, "ring"), type: "call.initiated" } as SessionEvent;
    const before = h.db.log.length;
    expect((await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs)).lean).toBe(true);
    expect(h.db.log.length).toBe(before);
    const result = await h.legEvent(operatorControlId, "call.initiated");
    expect(result.outcome).toBe("ignored");
    expect(h.callEvents(call.sessionId).at(-1)).toMatchObject({ event_type: "call.initiated", handled_status: "ignored" });
    const reads = h.db.log.slice(before).filter(row => row.operation === "select").map(row => row.table);
    expect(reads).not.toContain("motorist_telephony_settings");
    expect(reads).not.toContain("motorist_ivr_menus");
  });
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

/**
 * Colleague calls under `internal_lean_path` (call-speed S1.1). The lean
 * context must give `onOwnLegAnswered`/`fanoutInternalColleague` and
 * `onInternalCalleeAnswered` every field they read: the reduction from it is
 * the reduction from the full context, and stays so when every field it does
 * not supply is replaced by nonsense.
 */
describe("routing context for a colleague call", () => {
  const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
  function colleagueHarness(lean: boolean, endpoints = 1) {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    if (endpoints === 2) {
      for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
        VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
        APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
    }
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    h.deps.latencyFlags = { ...defaultLatencyFlags(), internal_lean_path: lean };
    if (endpoints === 2) h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: PROFILES.o2, environment: "development",
      sip_username: "native-colleague", device_session_id: "00000000-0000-4000-8000-000000009401", device_seen_at: h.now().toISOString(), registration_state: "registered" }]);
    return h;
  }
  async function colleague(h: TelephonyHarness) {
    const call = await callColleague({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) }, actor,
      { targetProfileId: PROFILES.o2, requestId: "00000000-0000-4000-8000-000000009402" });
    return call;
  }
  const event = (h: TelephonyHarness, callControlId: string, type: "call.answered" | "call.bridged") =>
    parseTelnyxEnvelope(h.envelope(type, { call_control_id: callControlId, client_state: encodeClientState(h.clientStateOf(callControlId)) }))!;
  /** Every field the lean context leaves out, set to something a reader could not miss. */
  const scrambled = (context: RoutingContext): RoutingContext => ({ ...context,
    line: { id: "scrambled", phone_number: "+421999999999", metadata: { announcements: { inboundStartAnnouncements: true, outboundStartAnnouncements: true } } } as never,
    settings: { ...DEFAULT_ROUTING_SETTINGS, maxConcurrentLegs: 0, maxRingFanout: 0, parkMaxMinutes: 1 },
    activeLegCount: 999, openOffers: [PROFILES.o2], presence: [{ profile_id: PROFILES.o2, status: "offline" } as never],
    devices: [], mobileDevices: [], ringPlan: null, ringPlans: {}, ivr: null, businessHours: null });
  const comparable = (result: ReturnType<typeof reduce>) => JSON.parse(JSON.stringify(result));

  async function contexts(h: TelephonyHarness, sessionId: string, answered: SessionEvent, config = h.deps.config) {
    const snapshot = await loadSessionSnapshot(h.deps, sessionId);
    const before = h.db.log.length;
    const lean = await loadRoutingContext({ ...h.deps, config }, snapshot.session, answered, snapshot.legs);
    const leanReads = h.db.log.slice(before).map(row => row.table);
    const full = await loadRoutingContext({ ...h.deps, config, latencyFlags: defaultLatencyFlags() }, snapshot.session, answered, snapshot.legs);
    const run = (context: RoutingContext) => comparable(reduce(snapshot.session, snapshot.legs, snapshot.attempts, answered, context));
    return { lean, full, leanReads, run };
  }

  it("stays on the full context while the switch is off", async () => {
    const h = colleagueHarness(false);
    const call = await colleague(h);
    const context = await contexts(h, call.sessionId, event(h, call.operatorLegCallControlId, "call.answered"));
    expect(context.lean.lean).toBeUndefined();
  });

  it.each([1, 2])("hands the caller's own answer (%i colleague endpoint(s)) everything it reads, and nothing else", async (endpoints) => {
    const h = colleagueHarness(true, endpoints);
    const call = await colleague(h);
    const answered = event(h, call.operatorLegCallControlId, "call.answered");
    const { lean, full, leanReads, run } = await contexts(h, call.sessionId, answered);

    expect(lean.lean).toBe(true);
    expect(full.lean).toBeUndefined();
    expect(leanReads).toEqual([]);
    expect(lean.fromNumber).toBe(full.fromNumber);
    const result = run(lean);
    expect(result.commands.length).toBeGreaterThan(0);
    expect(result).toEqual(run(full));
    expect(run(scrambled(lean))).toEqual(result);
  });

  it("falls back to the line's number exactly as the full context does, reading only that", async () => {
    const h = colleagueHarness(true);
    const call = await colleague(h);
    const answered = event(h, call.operatorLegCallControlId, "call.answered");
    if (!h.deps.config.configured) throw new Error("Expected configured fixture");
    const { lean, full, leanReads, run } = await contexts(h, call.sessionId, answered, { ...h.deps.config, defaultFromNumber: null });

    expect(lean.lean).toBe(true);
    expect(leanReads).toEqual(["motorist_telephony_lines"]);
    expect(lean.fromNumber).toBe(full.fromNumber);
    expect(lean.fromNumber).toBeTruthy();
    expect(run(lean)).toEqual(run(full));
  });

  it.each(["call.answered", "call.bridged"] as const)("hands the colleague's %s everything it reads", async (type) => {
    const h = colleagueHarness(true);
    const call = await colleague(h);
    h.telnyx.physical.answered(call.operatorLegCallControlId);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(h.session(call.sessionId).state).toBe("ringing");
    const callee = String(h.openLegFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
    const { lean, full, leanReads, run } = await contexts(h, call.sessionId, event(h, callee, type));

    expect(lean.lean).toBe(true);
    expect(leanReads).toEqual([]);
    const result = run(lean);
    expect(result.next.session.state).toBe("talking");
    expect(result).toEqual(run(full));
    expect(run(scrambled(lean))).toEqual(result);
  });

  it("keeps the full context for an inbound offer with the internal intent and once a call is ending", async () => {
    const h = createTelephonyHarness();
    h.deps.latencyFlags = { ...defaultLatencyFlags(), internal_lean_path: true };
    const { call, operatorControlId } = await ringing(h);
    expect((await contextFor(h, call.sessionId, answered(operatorControlId, "internal"))).lean).toBeUndefined();

    const colleagueWorld = colleagueHarness(true);
    const internal = await colleague(colleagueWorld);
    colleagueWorld.db.update("motorist_call_sessions", { termination_requested_at: colleagueWorld.now().toISOString() }, row => row.id === internal.sessionId);
    const ending = await contexts(colleagueWorld, internal.sessionId, event(colleagueWorld, internal.operatorLegCallControlId, "call.answered"));
    expect(ending.lean.lean).toBeUndefined();
  });
});

describe("routing context for a hangup", () => {
  async function talking(h: TelephonyHarness) {
    const { call, operatorControlId } = await ringing(h);
    await h.legEvent(operatorControlId, "call.answered");
    expect(h.session(call.sessionId).state).toBe("talking");
    return call;
  }

  const hangup = (id: string, h: TelephonyHarness): SessionEvent =>
    ({ kind: "app", type: "hangup", id, actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString() });

  // Top-level and the nested `termination:<sid>:<ts>` run alike: the hangup
  // reduce reads nothing from configuration, and `lean` stays unset so a
  // recording/sweep follow-up after the hangup does not reload the full context.
  it.each(["hangup", "termination:<sid>:<ts>"])("app hangup with recording frozen off reads nothing (%s)", async (id) => {
    const h = createTelephonyHarness();
    const call = await talking(h);
    const session = h.session(call.sessionId) as SessionRow;
    expect(readMeta(session).recording?.policy.enabled).toBe(false);
    const eventId = id.replace("<sid>", call.sessionId).replace("<ts>", h.now().toISOString());
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const before = h.db.log.length;

    const context = await loadRoutingContext(h.deps, snapshot.session, hangup(eventId, h), snapshot.legs);

    expect(h.db.log.length).toBe(before);
    expect(context.presence).toEqual([]);
    expect(context.devices).toEqual([]);
    expect(context.openOffers).toEqual([]);
    expect(context.activeLegCount).toBe(0);
    expect(context.settings).toBe(DEFAULT_ROUTING_SETTINGS);
    expect(context.recordingPolicy).toEqual(readMeta(session).recording?.policy);
    expect(context.lean).toBeUndefined();
  });

  it("app hangup with recording on keeps the frozen policy and still reads nothing", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h);
    const session = h.session(call.sessionId) as SessionRow;
    const meta = session.metadata as Record<string, unknown>;
    const recording = meta.recording as { policy: Record<string, unknown> };
    h.db.update("motorist_call_sessions",
      { metadata: { ...meta, recording: { ...recording, policy: { ...recording.policy, enabled: true } } } },
      row => row.id === call.sessionId);
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const before = h.db.log.length;

    const context = await loadRoutingContext(h.deps, snapshot.session, hangup("hangup", h), snapshot.legs);

    // Frozen recorder evidence is retained so teardown never erases capture
    // state; a hangup never re-reads the live policy for it.
    expect(h.db.log.length).toBe(before);
    expect(context.recordingPolicy?.enabled).toBe(true);
    expect(context.lean).toBeUndefined();
  });
});
