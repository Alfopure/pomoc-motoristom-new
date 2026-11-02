import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { FAKE_TELNYX_ENV } from "@/test/fake-telnyx";
import { callColleague, continueAcceptedHangup, createRateLimiter, hangupCall, startOutboundCall, type CallActor, type StartOutboundResult } from "./call-actions";
import { callBackRequest, type CallbackCallResult } from "./callbacks";
import { runPendingEffectRecovery } from "./cron-jobs";
import { defaultLatencyFlags, type LatencyFlags } from "./latency-flags";
import { transitionPresence } from "./routing/reservation";
import { readPendingEffects } from "./state/continuation";
import type { SessionRow } from "./state/types";
import { createTelnyxClient } from "./telnyx/client";
import { getTelnyxConfig } from "./telnyx/env";

/**
 * Call-speed S2: start-path compression and the early response. Every switch
 * defaults off; the suites around this one run unchanged with them off. These
 * cases pin what the switches promise when they are on.
 */

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const actor: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const FAST: Partial<LatencyFlags> = { start_fast_path: true };
const EARLY: Partial<LatencyFlags> = { start_early_response: true };
const ALL: Partial<LatencyFlags> = { start_fast_path: true, start_test_proof_prefetch: true, start_early_response: true };
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function world(flags: Partial<LatencyFlags> = {}, options: { realClient?: boolean } = {}) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), ...flags };
  // Identical retries recover from the journal's wire result, which only the
  // real HTTP adapter records; its provider is a fetch double.
  const posts: string[] = [];
  if (options.realClient) {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/v2/, "");
      if (init?.method === "POST") posts.push(path);
      const n = posts.length;
      return new Response(JSON.stringify({ data: path === "/calls"
        ? { call_control_id: `own-${n}`, call_leg_id: `own-leg-${n}`, call_session_id: `provider-${n}`, is_alive: true } : { result: "ok" } }), { status: 200 });
    });
    h.deps.telnyx = createTelnyxClient({ config: h.deps.config, fetch, liveGate: { callsEnabled: true, smsEnabled: false } });
  }
  const releases: Array<{ sessionId: unknown; applied: boolean }> = [];
  const actions: string[] = [];
  const transition = h.db.rpcHandlers.get("motorist_presence_transition_v1")!;
  h.db.registerRpc("motorist_presence_transition_v1", async (args, db) => {
    const result = await transition(args, db) as { applied: boolean };
    if (args.p_profile_id === actor.profileId) actions.push(String(args.p_action));
    if (args.p_action === "release") releases.push({ sessionId: args.p_session_id, applied: result.applied });
    return result;
  });
  const deps = { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
  return { h, deps, releases, actions, posts };
}
type World = ReturnType<typeof world>;

/** What a route does with the hook: it only resolves; the client's next step runs outside the start's lease. */
function earlyResponse() {
  let resolve!: (result: StartOutboundResult) => void;
  const promise = new Promise<StartOutboundResult>((done) => { resolve = done; });
  return { hook: (result: StartOutboundResult) => resolve(result), promise };
}

/** Parks the next request to `table` (the tail's history read) until released. */
function holdNext(h: TelephonyHarness, table: string) {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const atGate = new Promise<void>((done) => { reached = done; });
  const from = h.client.from;
  let armed = true;
  h.client.from = (name) => {
    const builder = from.call(h.client, name);
    if (!armed || name !== table) return builder;
    armed = false;
    const then = builder.then.bind(builder);
    builder.then = (fulfilled, rejected) => { reached(); return gate.then(() => then(fulfilled, rejected)); };
    return builder;
  };
  return { reached: atGate, release };
}

/** Releases `hold` the first time a lease acquisition is refused as busy. */
function releaseOnBusyLease(h: TelephonyHarness, hold: { release(): void }) {
  const acquire = h.db.rpcHandlers.get("motorist_session_lease_acquire_v2")!;
  let refused = 0;
  h.db.registerRpc("motorist_session_lease_acquire_v2", async (args, db) => {
    const claim = await acquire(args, db);
    if (!claim && refused++ === 0) hold.release();
    return claim;
  });
  return () => refused;
}

const outbound = (t: World, n = 7001, early?: (result: StartOutboundResult) => void) =>
  early ? startOutboundCall(t.deps, actor, { to: NUMBERS.customer, requestId: requestId(n) }, early)
    : startOutboundCall(t.deps, actor, { to: NUMBERS.customer, requestId: requestId(n) });
const colleague = (t: World, n = 7002, early?: (result: StartOutboundResult) => void) =>
  early ? callColleague(t.deps, actor, { targetProfileId: PROFILES.o2, requestId: requestId(n) }, early)
    : callColleague(t.deps, actor, { targetProfileId: PROFILES.o2, requestId: requestId(n) });

/** The durable outcome of a start, without the identities that differ between worlds. */
function outcome(h: TelephonyHarness, result: StartOutboundResult) {
  const session = h.session(result.sessionId) as SessionRow;
  return {
    session: { state: session.state, direction: session.direction, ended_at: session.ended_at, pending: readPendingEffects(session).entries.length,
      telnyx: Boolean(session.telnyx_session_id) },
    legs: h.legs(result.sessionId).map(leg => ({ role: leg.role, profile: leg.profile_id, to: leg.to_number, from: leg.from_number,
      open: !leg.ended_at, own: leg.telnyx_call_control_id === result.operatorLegCallControlId,
      dial: Boolean((leg.metadata as { dial_command_id?: string }).dial_command_id) })),
    call: (({ status, direction, operator_id, caller_number, called_number, end_reason }) => ({ status, direction, operator_id, caller_number, called_number, end_reason }))(h.call(result.sessionId)!),
    presence: (({ status, current_session_id }) => ({ status, current: current_session_id === result.sessionId }))(h.presence(actor.profileId)),
    dials: h.telnyx.of("dial").map(dial => ({ to: dial.params.to, from: dial.params.from, timeoutSecs: dial.params.timeoutSecs, headers: dial.params.customHeaders })),
    audit: h.callEvents(result.sessionId).some(row => (row.normalized_payload as { notes?: string[] }).notes?.includes("durable effects completed")),
    usage: h.rows("motorist_telephony_daily_usage").map(row => row.legs),
  };
}

describe("call-speed S2 start path", () => {
  it.each([
    ["outbound", outbound, "fast", FAST], ["outbound", outbound, "early", EARLY], ["outbound", outbound, "all", ALL],
    ["internal", colleague, "fast", FAST], ["internal", colleague, "early", EARLY], ["internal", colleague, "all", ALL],
  ] as const)("leaves the same %s call behind with the %s switches on as with them off", async (_kind, start, _name, flags) => {
    const off = world();
    const on = world(flags);
    const before = outcome(off.h, await start(off));
    let early: StartOutboundResult | null = null;
    const after = outcome(on.h, await (flags.start_early_response ? start(on, undefined, result => { early = result; }) : start(on)));
    expect(after).toEqual(before);
    if (flags.start_early_response) expect(early).toMatchObject({ operatorLegCallControlId: expect.any(String) });
    expect(before).toMatchObject({ session: { pending: 0 }, presence: { status: "on_call", current: true }, audit: true, legs: [{ own: true, open: true, dial: true }] });
  });

  it("reserves the operator once, without the presence read, the reused claim or the reads behind it", async () => {
    const t = world(FAST);
    const result = await outbound(t);
    const log = t.h.db.log;
    const dial = log.findIndex(row => row.table === "motorist_provider_command_prepare_v2");
    const beforeDial = log.slice(0, dial);
    // One `acquire` (it runs `dispatch` and `answer` inside one transaction)
    // and no second `dispatch` claim of the token this request already holds.
    expect(t.actions).toEqual(["dispatch", "answer", "acquire"]);
    expect(beforeDial.filter(row => row.table === "motorist_operator_presence")).toHaveLength(0);
    expect(beforeDial.filter(row => row.table === "motorist_call_legs")).toHaveLength(0);
    // History follows the dial; it is still written before the entry retires.
    expect(beforeDial.filter(row => row.table === "motorist_calls")).toHaveLength(0);
    expect(t.h.call(result.sessionId)).toMatchObject({ status: "outbound" });
    expect(readPendingEffects(t.h.session(result.sessionId) as SessionRow).entries).toEqual([]);
  });

  it("refuses a busy operator exactly as before, without a dial", async () => {
    for (const flags of [{}, FAST]) {
      const t = world(flags);
      t.h.setPresence(actor.profileId, { status: "on_call", current_session_id: "00000000-0000-4000-8000-0000000071ff", offer_token: "other" });
      await expect(outbound(t)).rejects.toMatchObject({ status: 409, code: "operator_busy" });
      const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
      expect(session).toMatchObject({ state: "failed" });
      expect(t.h.telnyx.of("dial")).toHaveLength(0);
    }
  });

  it("keeps an operator who cannot pause while the start holds them on the call", async () => {
    const t = world(FAST);
    const stage = t.h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    const refusals: unknown[] = [];
    t.h.db.registerRpc("motorist_stage_transition_v1", async (args, db) => {
      // Between the reservation and the dial, the operator presses "Pauza".
      refusals.push(await transitionPresence(t.h.admin, { organizationId: ORG, profileId: actor.profileId, action: "manual", status: "paused" }));
      return stage(args, db);
    });
    const result = await outbound(t);
    expect(refusals).toEqual([expect.objectContaining({ applied: false, reason: "on_call" })]);
    expect(t.h.telnyx.of("dial")).toHaveLength(1);
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "on_call", current_session_id: result.sessionId });
  });

  it("calls a colleague from a pause on the full dial path and leaves the caller paused", async () => {
    for (const flags of [{}, ALL]) {
      const t = world(flags);
      t.h.setPresence(actor.profileId, { status: "paused", current_session_id: null });
      const result = await colleague(t);
      expect(t.h.telnyx.of("dial")).toHaveLength(1);
      expect(t.h.presence(actor.profileId)).toMatchObject({ status: "paused", current_session_id: null });
      expect(readPendingEffects(t.h.session(result.sessionId) as SessionRow).entries).toEqual([]);
    }
  });
});

describe("call-speed S2 identical retries", () => {
  it("recovers a completed start whatever the guards would now say, without a second dial or a rate token", async () => {
    const t = world(ALL, { realClient: true });
    const first = await outbound(t);
    // The phone went offline meanwhile: a new start would be refused.
    t.h.db.update("motorist_operator_devices", { device_seen_at: "2026-09-01T00:00:00.000Z" }, row => row.profile_id === actor.profileId);
    await expect(outbound(t, 7003)).rejects.toMatchObject({ code: "device_offline" });
    for (let attempt = 0; attempt < 11; attempt += 1) {
      expect(await outbound(t)).toMatchObject({ sessionId: first.sessionId, operatorLegCallControlId: first.operatorLegCallControlId });
    }
    expect(t.posts.filter(path => path === "/calls")).toHaveLength(1);
    // Eleven identical retries took no token from the per-minute bucket of ten.
    t.h.touchDevice(actor.profileId);
    t.h.setPresence(actor.profileId, { status: "available", current_session_id: null, offer_token: null });
    await expect(colleague(t)).resolves.toMatchObject({ operatorLegCallControlId: "own-2" });
  });

  it("answers a retry during the detached tail with the same leg and no second fetch", async () => {
    const t = world(ALL, { realClient: true });
    const hold = holdNext(t.h, "motorist_calls");
    const refused = releaseOnBusyLease(t.h, hold);
    const early = earlyResponse();
    const start = outbound(t, 7101, early.hook);
    const first = await early.promise;
    await hold.reached;
    // The 201 has left and the tail still holds the lease: the client retries.
    const retry = await outbound(t, 7101);
    expect(refused()).toBeGreaterThan(0);
    expect(retry).toMatchObject({ sessionId: first.sessionId, operatorLegCallControlId: first.operatorLegCallControlId });
    expect(await start).toEqual(first);
    expect(t.posts.filter(path => path === "/calls")).toHaveLength(1);
    expect(t.h.rows("motorist_call_sessions")).toHaveLength(1);
  });
});

describe("call-speed S2 early response", () => {
  it("fires once the own leg is journalled and recorded, before the history and the final checkpoint", async () => {
    const t = world(ALL);
    let seen: { leg: boolean; history: boolean; pending: number; journal: unknown } | null = null;
    const result = await outbound(t, 7201, early => {
      const session = t.h.session(early.sessionId) as SessionRow;
      seen = { leg: t.h.legs(early.sessionId).some(leg => leg.telnyx_call_control_id === early.operatorLegCallControlId && !leg.ended_at),
        history: Boolean(t.h.call(early.sessionId)), pending: readPendingEffects(session).entries.length,
        journal: t.h.rows("motorist_provider_commands").find(row => row.session_id === early.sessionId)?.outcome };
    });
    expect(seen).toEqual({ leg: true, history: false, pending: 1, journal: "accepted" });
    expect(t.h.call(result.sessionId)).toMatchObject({ status: "outbound" });
    expect(readPendingEffects(t.h.session(result.sessionId) as SessionRow).entries).toEqual([]);
  });

  it.each(["outbound", "internal"] as const)("does not fire for an unknown provider outcome and keeps today's %s error", async (kind) => {
    for (const flags of [{}, ALL]) {
      const t = world(flags);
      t.h.telnyx.loseNextResponse("dial");
      const early = vi.fn();
      await expect(kind === "outbound" ? outbound(t, 7301, early) : colleague(t, 7302, early)).rejects.toMatchObject({ status: 503, code: "provider_outcome_unknown" });
      expect(early).not.toHaveBeenCalled();
      const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
      expect(readPendingEffects(session).entries).toHaveLength(1);
      // The retry resumes the journalled dial: no second provider request.
      t.h.telnyx.physical.answered([...t.h.telnyx.physical.legs.keys()][0]!);
      await (kind === "outbound" ? outbound(t, 7301) : colleague(t, 7302)).catch(() => undefined);
      expect(t.h.telnyx.of("dial")).toHaveLength(1);
    }
  });

  it("does not fire for a refused dial; the operator is released and the error is today's", async () => {
    const t = world(ALL);
    t.h.telnyx.failNext("dial", "provider refused");
    const early = vi.fn();
    await expect(outbound(t, 7401, early)).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    expect(early).not.toHaveBeenCalled();
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("ends the call through its ordinary path when the operator hangs up during the tail", async () => {
    const t = world(ALL);
    const hold = holdNext(t.h, "motorist_calls");
    const early = earlyResponse();
    const start = outbound(t, 7501, early.hook);
    const started = await early.promise;
    await hold.reached;
    // The console has its 201 and the operator hangs up while the tail holds the lease.
    const hangup = await hangupCall(t.deps, actor, started.sessionId);
    expect(hangup).toMatchObject({ terminationPending: true });
    hold.release();
    expect(await start).toEqual(started);
    expect(t.h.session(started.sessionId).termination_requested_at).toBeTruthy();
    // The hangup's retained continuation (or the next event, or cron) runs the intent.
    await continueAcceptedHangup(t.deps, started.sessionId);
    expect(t.h.telnyx.of("hangup").map(call => call.params.callControlId)).toContain(started.operatorLegCallControlId);
    await t.h.legEvent(started.operatorLegCallControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    const session = t.h.session(started.sessionId) as SessionRow;
    expect(session).toMatchObject({ ended_at: expect.any(String) });
    expect(readPendingEffects(session).entries).toEqual([]);
    expect(t.h.presence(actor.profileId)).toMatchObject({ current_session_id: null });
    expect(t.releases.filter(release => release.sessionId === started.sessionId && release.applied)).toHaveLength(1);
    expect(t.h.call(started.sessionId)).toBeTruthy();
  });

  it.each(["webhook", "cron"] as const)("leaves a tail that dies after the response to the existing recovery (%s)", async (recovery) => {
    const t = world(ALL);
    // The invocation dies at its final checkpoint, after the 201 left: neither
    // that write nor the failure bookkeeping behind it reaches the database.
    const result = await outbound(t, 7601, () => {
      t.h.db.failNext("motorist_call_sessions", "update", "instance stopped");
      t.h.db.failNext("motorist_call_sessions", "update", "instance stopped");
    });
    const [pending] = readPendingEffects(t.h.session(result.sessionId) as SessionRow).entries;
    expect(pending).toMatchObject({ attempts: 0, completedCommands: [] });
    // The leg row written before the response is what a resume adopts.
    expect(t.h.legs(result.sessionId)).toMatchObject([{ telnyx_call_control_id: result.operatorLegCallControlId, ended_at: null }]);
    if (recovery === "webhook") await t.h.legEvent(result.operatorLegCallControlId, "call.initiated");
    else { t.h.advance(60_000); await runPendingEffectRecovery(t.deps); }
    expect(readPendingEffects(t.h.session(result.sessionId) as SessionRow).entries).toEqual([]);
    expect(t.h.telnyx.of("dial")).toHaveLength(1);
    expect(t.h.call(result.sessionId)).toMatchObject({ status: "outbound" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "on_call", current_session_id: result.sessionId });
  });

  it("never retires the entry without its call row when the history write fails after the response", async () => {
    const t = world(ALL);
    const result = await outbound(t, 7701, () => t.h.db.failNext("motorist_calls", "insert", "history unavailable"));
    const retiredWithoutRow = () => !readPendingEffects(t.h.session(result.sessionId) as SessionRow).entries.length && !t.h.call(result.sessionId);
    expect(t.h.call(result.sessionId)).toBeNull();
    expect(readPendingEffects(t.h.session(result.sessionId) as SessionRow).entries).toHaveLength(1);
    await t.h.legEvent(result.operatorLegCallControlId, "call.initiated");
    expect(retiredWithoutRow()).toBe(false);
    t.h.advance(60_000);
    await runPendingEffectRecovery(t.deps);
    expect(t.h.call(result.sessionId)).toMatchObject({ status: "outbound" });
    expect(readPendingEffects(t.h.session(result.sessionId) as SessionRow).entries).toEqual([]);
    expect(t.h.telnyx.of("dial")).toHaveLength(1);
  });

  it("logs, never retains, a lost start audit written beside the final checkpoint", async () => {
    const t = world(ALL);
    const result = await outbound(t, 7801, () => t.h.db.failNext("motorist_call_events", "upsert", "audit unavailable"));
    expect(readPendingEffects(t.h.session(result.sessionId) as SessionRow).entries).toEqual([]);
    expect(t.h.call(result.sessionId)).toMatchObject({ status: "outbound" });
    expect(t.h.logs).toContainEqual(expect.objectContaining({ code: "initial_audit_unrecorded", sessionId: result.sessionId }));
  });

  it("ends a start the operator hung up before the dial, without the validity read, as cancelled", async () => {
    const t = world(ALL);
    const stage = t.h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    t.h.db.registerRpc("motorist_stage_transition_v1", async (args, db) => {
      const staged = await stage(args, db);
      if ((args.p_main as { entry: { id: string } }).entry.id.startsWith("initial:")) {
        await t.h.db.rpcHandlers.get("motorist_session_terminate_v2")!({ p_organization_id: ORG, p_session_id: args.p_session_id }, db);
        // The fast path never needs the journal: `prepare_v2`'s refusal is the proof.
        t.h.db.failNext("motorist_provider_command_lookup_v2", "rpc", "journal unavailable");
      }
      return staged;
    });
    const early = vi.fn();
    await expect(outbound(t, 7901, early)).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    expect(early).not.toHaveBeenCalled();
    expect(t.h.telnyx.of("dial")).toHaveLength(0);
    expect(session).toMatchObject({ state: "ended" });
    expect(t.h.call(session.id)).toMatchObject({ status: "ended", end_reason: "cancelled_before_dial" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    expect(t.releases.filter(release => release.sessionId === session.id && release.applied)).toHaveLength(1);
  });

  it("links a callback request outside the lease and answers it before the tail", async () => {
    const t = world(ALL);
    const [request] = t.h.db.insert("motorist_callback_requests", { organization_id: ORG, caller_number: NUMBERS.customer, source: "missed", status: "open",
      line_id: null, case_id: null, metadata: {} });
    // The pre-dial link keeps its place under the lease (`motorist_link_callback_outbound_v1`).
    t.h.db.registerRpc("motorist_link_callback_outbound_v1", args => {
      expect(t.h.telnyx.of("dial")).toHaveLength(0);
      t.h.db.update("motorist_callback_requests", { metadata: { callback_call: { session_id: args.p_session_id, by: args.p_actor_id } } }, row => row.id === request.id);
      return true;
    });
    const hold = holdNext(t.h, "motorist_calls");
    let answer!: (value: CallbackCallResult) => void;
    const answered = new Promise<CallbackCallResult>((resolve) => { answer = resolve; });
    const work = callBackRequest(t.deps, actor, String(request.id), undefined, requestId(7951), answer);
    const early = await answered;
    // The request row is settled while the start's tail is still parked on its history write.
    await hold.reached;
    expect(early).toMatchObject({ linked: true, request: { id: request.id }, call: { operatorLegCallControlId: expect.any(String) } });
    expect(t.h.call(early.call.sessionId)).toBeNull();
    let finished = false;
    void work.then(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    hold.release();
    expect(await work).toEqual(early);
    expect(t.h.call(early.call.sessionId)).toMatchObject({ status: "outbound" });
  });
});

describe("call-speed S2 TEST destination proof prefetch", () => {
  const env = { ...FAKE_TELNYX_ENV, MOTORIST_APP_ENV: "test", MOTORIST_TEST_LIVE_INTEGRATIONS: "true",
    MOTORIST_TEST_ALLOW_ANY_PHONE_NUMBER: "true", MOTORIST_TEST_FROM_NUMBERS: NUMBERS.allianz,
    VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
    SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk" };

  function testWorld(flags: Partial<LatencyFlags>) {
    const t = world(flags);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    t.h.db.update("motorist_profiles", { kind: "human" }, () => true);
    const sent: Array<{ method: string; path: string; at: number }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/v2/, "");
      sent.push({ method: options?.method ?? "GET", path, at: t.h.db.log.length });
      const data = path.startsWith("/telephony_credentials/")
        ? { resource_id: "connection:cred-connection-test", expired: false, sip_username: "gencred001" }
        : { call_control_id: "own-leg", call_leg_id: "own-leg-id", call_session_id: "provider-session", is_alive: true };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const config = getTelnyxConfig({ ...env, TELNYX_CALL_CONTROL_APP_ID: "app-test", TELNYX_CREDENTIAL_CONNECTION_ID: "cred-connection-test" });
    const client = createTelnyxClient({ config, fetch, liveGate: { callsEnabled: true, smsEnabled: false }, testProvenanceContext: { admin: t.h.admin, organizationId: ORG } });
    t.deps.telnyx = client;
    t.deps.config = config;
    return { ...t, sent, client };
  }

  it("proves the own destination before the lease, so the dial runs no serial guard", async () => {
    const t = testWorld({ start_fast_path: true, start_test_proof_prefetch: true });
    const result = await outbound(t);
    expect(result.operatorLegCallControlId).toBe("own-leg");
    const credentialChecks = t.sent.filter(row => row.path.startsWith("/telephony_credentials/"));
    expect(credentialChecks).toHaveLength(1);
    const prepare = t.h.db.log.findIndex(row => row.table === "motorist_provider_command_prepare_v2");
    const acquire = t.h.db.log.findIndex(row => row.table === "motorist_session_lease_acquire_v2");
    const enrollment = t.h.db.log.map((row, index) => ({ row, index })).filter(({ row }) => row.table === "motorist_operator_mobile_devices");
    expect(enrollment.length).toBe(1);
    expect(enrollment[0].index).toBeLessThan(prepare);
    expect(credentialChecks[0].at).toBeLessThan(prepare);
    expect(acquire).toBeGreaterThan(0);
  });

  it("keeps the serial guard without the switch", async () => {
    const t = testWorld({ start_fast_path: true });
    await outbound(t);
    const prepare = t.h.db.log.findIndex(row => row.table === "motorist_provider_command_prepare_v2");
    const check = t.sent.find(row => row.path.startsWith("/telephony_credentials/"))!;
    // The guard runs inside the dial, after the startup entry was staged.
    expect(check.at).toBeGreaterThan(t.h.db.log.findIndex(row => row.table === "motorist_stage_transition_v1"));
    expect(check.at).toBeLessThanOrEqual(prepare + 1);
  });

  it("refuses an unproven destination before anything is reserved or dialled", async () => {
    const t = testWorld({ start_fast_path: true, start_test_proof_prefetch: true });
    t.h.db.update("motorist_operator_devices", { telnyx_credential_id: null }, row => row.profile_id === actor.profileId);
    await expect(outbound(t)).rejects.toMatchObject({ status: 423, code: "test_provider_boundary" });
    expect(t.actions).toEqual([]);
    expect(t.sent.filter(row => row.method === "POST")).toHaveLength(0);
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    expect(session).toMatchObject({ state: "failed" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("uses a proof once, for its own destination only", async () => {
    const t = testWorld({});
    await t.client.proveSipDestination!("sip:gencred001@sip.telnyx.com");
    expect(t.client.proveSipDestination!(NUMBERS.customer)).toBeNull();
    const checks = () => t.sent.filter(row => row.path.startsWith("/telephony_credentials/")).length;
    expect(checks()).toBe(1);
    const dial = (to: string, commandId: string) => t.client.dial({ commandId, to, from: NUMBERS.allianz, clientState: "e30=", timeoutSecs: 30 });
    await dial("sip:gencred001@sip.telnyx.com", "first");
    expect(checks()).toBe(1);
    await dial("sip:gencred001@sip.telnyx.com", "second");
    expect(checks()).toBe(2);
    await expect(dial("sip:gencred002@sip.telnyx.com", "other")).rejects.toMatchObject({ code: "test_provider_boundary" });
  });
});
