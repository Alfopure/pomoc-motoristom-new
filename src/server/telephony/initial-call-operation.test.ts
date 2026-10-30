import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { callColleague, startOutboundCall, createRateLimiter, type CallActor } from "./call-actions";
import { initialOperationIdentity } from "./initial-call-operation";
import { createTelnyxClient } from "./telnyx/client";
import { getTelnyxConfig } from "./telnyx/env";
import { readPendingEffects } from "./state/continuation";
import type { SessionRow } from "./state/types";
import * as effects from "./state/effects";
import { SessionLeaseLostError } from "./service-errors";
import { runPendingEffectRecovery } from "./cron-jobs";

const actor: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Operator" };
const requestId = "00000000-0000-4000-8000-000000000991";
const sessionId = "00000000-0000-4000-8000-000000000992";
const input = { to: NUMBERS.customer, requestId };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function prepared() {
  const h = createTelephonyHarness();
  type Journal = { fingerprint: unknown; outcome: string; result?: unknown };
  const records = new Map<string, Journal>();
  let generation = 0;
  h.db.registerRpc("motorist_session_lease_acquire_v2", () => ({ generation: ++generation, contract: 2 }));
  h.db.registerRpc("motorist_session_lease_renew_v2", () => true);
  h.db.registerRpc("motorist_session_lease_release_v2", () => true);
  h.db.registerRpc("motorist_provider_command_lookup_v2", args => records.get(String(args.p_command_id)) ?? null);
  h.db.registerRpc("motorist_provider_command_prepare_v2", args => {
    const id = String(args.p_command_id), prior = records.get(id);
    if (prior) {
      if (prior.fingerprint !== args.p_fingerprint) throw new Error("immutable payload changed");
      return { dispatch: false, ...prior };
    }
    // The provider intent must never precede the durable local obligation.
    expect(readPendingEffects(h.session(sessionId) as SessionRow).entries).toHaveLength(1);
    records.set(id, { fingerprint: args.p_fingerprint, outcome: "unknown" });
    return { dispatch: true };
  });
  h.db.registerRpc("motorist_provider_command_result_v2", args => {
    const prior = records.get(String(args.p_command_id))!;
    prior.outcome = Number(args.p_status) < 300 ? "accepted" : "rejected";
    prior.result = args.p_result;
    return true;
  });
  h.db.seed("motorist_call_sessions", [{ id: sessionId, organization_id: h.deps.organizationId, writer_contract: 2,
    direction: "outbound", state: "received", answered_by_profile_id: actor.profileId, caller_number: NUMBERS.allianz,
    called_number: NUMBERS.customer, metadata: { outbound: { to: NUMBERS.customer, from: NUMBERS.allianz, by: actor.profileId },
      initial_operation: { ...initialOperationIdentity(actor, "outbound", input), to: NUMBERS.customer, from: NUMBERS.allianz,
        sipUri: "sip:gencred001@sip.telnyx.com", fromDisplayName: "Frozen name", request: input } } }]);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { call_control_id: "accepted-leg", call_leg_id: "provider-leg", call_session_id: "provider-session", is_alive: true } }), { status: 200 }));
  const config = getTelnyxConfig({ TELNYX_API_KEY: "test", TELNYX_CALL_CONTROL_APP_ID: "app", TELNYX_API_BASE_URL: "https://telnyx.test/v2" });
  const telnyx = createTelnyxClient({ config, fetch, liveGate: { callsEnabled: true, smsEnabled: false } });
  const deps = { ...h.deps, telnyx, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
  const pending = () => readPendingEffects(h.session(sessionId) as SessionRow).entries;
  return { h, deps, fetch, records, pending, start: () => startOutboundCall(deps, actor, input) };
}

describe("initial call operation recovery", () => {
  it("skips journal recovery only for a newly created, untouched session", async () => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { call_control_id: "new-own-leg", call_leg_id: "new-leg-id", call_session_id: "new-provider-session" } }), { status: 200 }));
    const telnyx = createTelnyxClient({ config: h.deps.config, fetch, liveGate: { callsEnabled: true, smsEnabled: false } });
    const deps = { ...h.deps, telnyx, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
    const input = { to: NUMBERS.customer, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const first = await startOutboundCall(deps, actor, input);
    expect(h.db.log.filter(row => row.table === "motorist_provider_command_lookup_v2")).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const retried = await startOutboundCall(deps, actor, input);
    expect(retried.operatorLegCallControlId).toBe(first.operatorLegCallControlId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.db.log.some(row => row.table === "motorist_provider_command_lookup_v2")).toBe(true);
  });
  it("returns completed startup evidence without rereading the accepted journal", async () => {
    const t = prepared();
    t.h.db.registerRpc("motorist_provider_command_lookup_v2", args => {
      const prior = t.records.get(String(args.p_command_id));
      if (prior?.outcome === "accepted") throw new Error("completed startup must not reread its accepted journal");
      return prior ?? null;
    });
    expect(await t.start()).toMatchObject({ sessionId, operatorLegCallControlId: "accepted-leg", telnyxSessionId: "provider-session" });
    expect(t.pending()).toEqual([]);
    expect(t.h.call(sessionId)).toBeTruthy();
    expect(t.h.legs(sessionId)).toMatchObject([{ telnyx_call_control_id: "accepted-leg", ended_at: null }]);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("still rejects an ended materialized leg when the session has not caught up", async () => {
    const t = prepared();
    const resume = effects.resumePendingEffects;
    vi.spyOn(effects, "resumePendingEffects").mockImplementationOnce(async (...args) => {
      const completed = await resume(...args);
      t.h.db.update("motorist_call_legs", { state: "ended", ended_at: t.h.now().toISOString() }, row => row.session_id === sessionId);
      return completed;
    });
    await expect(t.start()).rejects.toMatchObject({ code: "initial_call_ended", status: 409 });
    expect(t.h.session(sessionId).ended_at).toBeNull();
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("recovers a crash before dispatch from the frozen plan and stages before HTTP", async () => {
    const t = prepared();
    t.h.db.failNext("motorist_telephony_settings", "select", "live preflight must not run again");
    expect(await t.start()).toMatchObject({ sessionId, operatorLegCallControlId: "accepted-leg" });
    expect(t.h.rows("motorist_call_sessions")).toHaveLength(1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    const request = t.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toMatchObject({ to: "sip:gencred001@sip.telnyx.com", from_display_name: "Frozen name" });
    expect(t.pending()).toEqual([]);
  });

  it("repairs an accepted missing leg on HTTP retry before mutable presence validation", async () => {
    const t = prepared();
    t.h.db.failNext("motorist_call_legs", "upsert", "leg materialization unavailable");
    expect(await t.start()).toMatchObject({ operatorLegCallControlId: "accepted-leg" });
    expect(t.h.legs(sessionId)).toHaveLength(0);
    expect(t.pending()).toHaveLength(1);
    t.h.setPresence(actor.profileId, { status: "on_call", current_session_id: "later-owner", offer_token: "later-token" });
    t.h.db.failNext("motorist_operator_presence", "select", "mutable presence must not replace accepted evidence");
    expect(await t.start()).toMatchObject({ operatorLegCallControlId: "accepted-leg" });
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.h.legs(sessionId)).toHaveLength(1);
    expect(t.h.call(sessionId)).toBeTruthy();
    expect(t.pending()).toEqual([]);
  });

  it("existing cron repairs accepted startup without HTTP retry or any webhook", async () => {
    const t = prepared();
    t.h.db.failNext("motorist_call_legs", "upsert", "accepted leg not yet stored");
    await t.start();
    expect(t.pending()).toHaveLength(1);
    t.h.advance(31_000);
    const result = await runPendingEffectRecovery(t.deps);
    expect(result).toMatchObject({ status: "ok", detail: { errors: [] } });
    expect(t.h.legs(sessionId)).toHaveLength(1);
    expect(t.h.call(sessionId)).toBeTruthy();
    expect(t.pending()).toEqual([]);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("retains the obligation when accepted response precedes a lost checkpoint", async () => {
    const t = prepared();
    t.fetch.mockImplementationOnce(async () => {
      // Any continuation checkpoint after provider dispatch now fails.
      t.h.db.failNext("motorist_call_sessions", "update", "optional session link lost");
      t.h.db.failNext("motorist_call_sessions", "update", "mandatory command checkpoint lost");
      return new Response(JSON.stringify({ data: { call_control_id: "accepted-leg", call_leg_id: "provider-leg", call_session_id: "provider-session", is_alive: true } }), { status: 200 });
    });
    await t.start();
    expect(t.pending()).toHaveLength(1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await t.start();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.h.legs(sessionId)).toHaveLength(1);
  });

  it("cron resumes a staged obligation when the process failed before dispatch admission", async () => {
    const t = prepared();
    t.h.db.failNext("motorist_provider_command_prepare_v2", "rpc", "admission unavailable");
    await expect(t.start()).rejects.toMatchObject({ status: 503, code: "initial_call_pending" });
    expect(t.pending()).toHaveLength(1);
    expect(t.fetch).toHaveBeenCalledTimes(0);
    t.h.advance(31_000);
    expect(await runPendingEffectRecovery(t.deps)).toMatchObject({ status: "ok" });
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.h.legs(sessionId)).toHaveLength(1);
    expect(t.pending()).toEqual([]);
  });

  it.each([61_000, 301_000])("retains unknown without another POST after %d ms", async age => {
    const t = prepared();
    t.fetch.mockRejectedValue(new Error("provider may have accepted; reply lost"));
    await expect(t.start()).rejects.toMatchObject({ status: 503, code: "provider_outcome_unknown" });
    expect(t.pending()).toHaveLength(1);
    t.h.advance(age);
    await expect(t.start()).rejects.toMatchObject({ status: 503, code: "provider_outcome_unknown" });
    await runPendingEffectRecovery(t.deps);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.pending()).toHaveLength(1);
    expect(t.h.rows("motorist_call_sessions")).toHaveLength(1);
    expect(t.h.session(sessionId).ended_at).toBeNull();
  });

  it("does not revive an ended exact leg when its materialization checkpoint resumes", async () => {
    const t = prepared();
    t.h.db.failNext("motorist_call_events", "upsert", "audit unavailable");
    await t.start();
    expect(t.pending()).toHaveLength(1);
    const ended = t.h.now().toISOString();
    t.h.db.update("motorist_call_legs", { state: "ended", ended_at: ended }, row => row.session_id === sessionId);
    t.h.db.update("motorist_call_sessions", { state: "ended", ended_at: ended }, row => row.id === sessionId);
    await expect(t.start()).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    t.h.advance(31_000);
    await runPendingEffectRecovery(t.deps);
    expect(t.h.session(sessionId)).toMatchObject({ state: "ended", ended_at: ended });
    expect(t.h.legs(sessionId)).toMatchObject([{ state: "ended", ended_at: ended }]);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("a delayed accepted response cannot revive a session or exact leg ended during POST", async () => {
    const t = prepared();
    const ended = t.h.now().toISOString();
    t.fetch.mockImplementationOnce(async () => {
      t.h.db.update("motorist_call_sessions", { state: "ended", ended_at: ended,
        termination_requested_at: ended, termination_next_attempt_at: ended }, row => row.id === sessionId);
      t.h.db.insert("motorist_call_legs", { organization_id: t.deps.organizationId, session_id: sessionId,
        telnyx_call_control_id: "accepted-leg", role: "operator", profile_id: actor.profileId, state: "ended", ended_at: ended });
      return new Response(JSON.stringify({ data: { call_control_id: "accepted-leg", call_leg_id: "provider-leg", call_session_id: "provider-session", is_alive: true } }), { status: 200 });
    });
    await expect(t.start()).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    expect(t.h.session(sessionId)).toMatchObject({ state: "ended", ended_at: ended, termination_next_attempt_at: ended });
    expect(t.h.legs(sessionId)).toMatchObject([{ state: "ended", ended_at: ended }]);
    await expect(t.start()).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("a definite refusal releases the original reservation and settles startup debt", async () => {
    const t = prepared();
    t.fetch.mockResolvedValue(new Response(JSON.stringify({ errors: [{ code: "10000", title: "Invalid destination" }] }), { status: 422 }));
    await expect(t.start()).rejects.toMatchObject({ status: 409 });
    expect(t.h.session(sessionId)).toMatchObject({ state: "failed" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    expect(t.pending()).toEqual([]);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("accepted replay retains exact revoked-offer cleanup without a second dial", async () => {
    const t = prepared();
    t.h.db.failNext("motorist_call_legs", "upsert", "leg not yet stored");
    await t.start();
    const dial = t.pending()[0].commands[0];
    if (dial.kind !== "dial") throw new Error("expected frozen dial");
    const token = dial.clientState.offerToken ?? `legacy:${actor.profileId}`;
    t.h.db.update("motorist_call_sessions", { presence_cancellations: { [token]: { profileId: actor.profileId, requestedAt: t.h.now().toISOString(), reason: "cancelled" } } }, row => row.id === sessionId);
    t.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200 }));
    await t.start();
    const urls = t.fetch.mock.calls.map(args => String((args as unknown as [string])[0]));
    expect(urls.filter(url => url.endsWith("/calls"))).toHaveLength(1);
    expect(urls.filter(url => url.endsWith("/calls/accepted-leg/actions/hangup"))).toHaveLength(1);
    expect(t.h.session(sessionId).cancellations_next_attempt_at).toBeNull();
  });

  it("does not look up acceptance after continuation ownership is lost", async () => {
    const t = prepared();
    t.h.db.failNext("motorist_call_legs", "upsert", "leg not yet stored");
    await t.start();
    const count = () => t.h.db.log.filter(row => row.table === "motorist_provider_command_lookup_v2").length;
    const before = count();
    vi.spyOn(effects, "resumePendingEffects").mockRejectedValueOnce(new SessionLeaseLostError());
    await expect(t.start()).rejects.toBeInstanceOf(SessionLeaseLostError);
    expect(count()).toBe(before);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects request reuse with changed payload before any provider command", async () => {
    const t = prepared();
    await expect(startOutboundCall(t.deps, actor, { ...input, to: "+421900000099" })).rejects.toMatchObject({ status: 409, code: "request_id_conflict" });
    expect(t.fetch).toHaveBeenCalledTimes(0);
    expect(t.h.rows("motorist_call_sessions")).toHaveLength(1);
  });
});

/**
 * A hangup can commit its termination (`terminate_v2`) before the startup's own
 * dial reaches the provider. The startup entry's compensation is the only
 * thing that ends such a session and frees its operator.
 */
describe("hangup before the first dial", () => {
  function world() {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const releases: Array<{ sessionId: unknown; applied: boolean }> = [];
    const transition = h.db.rpcHandlers.get("motorist_presence_transition_v1")!;
    h.db.registerRpc("motorist_presence_transition_v1", async (args, db) => {
      const result = await transition(args, db) as { applied: boolean };
      if (args.p_action === "release") releases.push({ sessionId: args.p_session_id, applied: result.applied });
      return result;
    });
    // What `hangupCall` commits before it waits for the lease.
    const terminate = (id: unknown) => h.db.rpcHandlers.get("motorist_session_terminate_v2")!({ p_organization_id: ORG, p_session_id: id }, h.db);
    const deps = { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
    return { h, deps, releases, terminate };
  }
  type World = ReturnType<typeof world>;
  const start = (t: World, kind: "outbound" | "internal") => kind === "outbound"
    ? startOutboundCall(t.deps, actor, { to: NUMBERS.customer, requestId: "00000000-0000-4000-8000-0000000005c1" })
    : callColleague(t.deps, actor, { targetProfileId: PROFILES.o2, requestId: "00000000-0000-4000-8000-0000000005c2" });

  function expectCancelled(t: World, reserved: boolean) {
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    expect(t.h.telnyx.of("dial")).toHaveLength(0);
    expect(session).toMatchObject({ state: "ended", ended_at: expect.any(String), termination_requested_at: expect.any(String) });
    expect(readPendingEffects(session).entries).toEqual([]);
    expect(t.h.call(session.id)).toMatchObject({ status: "ended", end_reason: "cancelled_before_dial" });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    // Released exactly once when the startup had reserved the operator; never reserved, never touched.
    expect(t.releases.filter(release => release.sessionId === session.id && release.applied)).toHaveLength(reserved ? 1 : 0);
  }

  it.each(["outbound", "internal"] as const)("ends an %s call terminated between INSERT and the lease, before any reservation", async (kind) => {
    const t = world();
    const acquire = t.h.db.rpcHandlers.get("motorist_session_lease_acquire_v2")!;
    let first = true;
    t.h.db.registerRpc("motorist_session_lease_acquire_v2", async (args, db) => {
      if (first) { first = false; await t.terminate(args.p_session_id); }
      return acquire(args, db);
    });
    const revision = t.h.presence(actor.profileId).presence_revision;
    await expect(start(t, kind)).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    expectCancelled(t, false);
    expect(t.h.presence(actor.profileId).presence_revision).toBe(revision);
  });

  it.each(["outbound", "internal"] as const)("compensates an %s dial that prepare_v2 refuses after staging", async (kind) => {
    const t = world();
    const prepare = t.h.db.rpcHandlers.get("motorist_provider_command_prepare_v2")!;
    let terminated = false;
    t.h.db.registerRpc("motorist_provider_command_prepare_v2", async (args, db) => {
      if (args.p_path === "/calls" && !terminated) {
        terminated = true;
        expect(t.h.presence(actor.profileId)).toMatchObject({ status: "on_call", current_session_id: args.p_session_id });
        await t.terminate(args.p_session_id);
      }
      return prepare(args, db);
    });
    await expect(start(t, kind)).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    expect(terminated).toBe(true);
    expectCancelled(t, true);
  });

  it("compensates a dial whose validity read already sees the termination", async () => {
    const t = world();
    const stage = t.h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    t.h.db.registerRpc("motorist_stage_transition_v1", async (args, db) => {
      const staged = await stage(args, db);
      const entry = (args.p_main as { entry: { id: string } }).entry;
      if (entry.id.startsWith("initial:")) await t.terminate(args.p_session_id);
      return staged;
    });
    await expect(start(t, "outbound")).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    expectCancelled(t, true);
  });

  it("changes nothing when the journal cannot be read after the validity read", async () => {
    const t = world();
    const stage = t.h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    t.h.db.registerRpc("motorist_stage_transition_v1", async (args, db) => {
      const staged = await stage(args, db);
      if ((args.p_main as { entry: { id: string } }).entry.id.startsWith("initial:")) {
        await t.terminate(args.p_session_id);
        t.h.db.failNext("motorist_provider_command_lookup_v2", "rpc", "journal unavailable");
      }
      return staged;
    });
    await expect(start(t, "outbound")).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    expect(t.h.telnyx.of("dial")).toHaveLength(0);
    expect(t.h.call(session.id)?.end_reason ?? null).not.toBe("cancelled_before_dial");
    expect(t.h.logs).toContainEqual(expect.objectContaining({ code: "initial_cancellation_unverified", sessionId: session.id }));
    expect(t.h.rows("motorist_job_incidents")).toHaveLength(0);
  });

  it("leaves a dial whose provider outcome is unknown to the termination machinery", async () => {
    const t = world();
    t.h.telnyx.loseNextResponse("dial");
    await expect(start(t, "outbound")).rejects.toMatchObject({ status: 503, code: "provider_outcome_unknown" });
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    expect(readPendingEffects(session).entries).toHaveLength(1);
    await t.terminate(session.id);
    // The retry resumes the staged dial: the provider may have taken it, so it is not "cancelled before dial".
    await expect(start(t, "outbound")).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    expect(t.h.telnyx.of("dial")).toHaveLength(1);
    expect(t.h.call(session.id)?.end_reason ?? null).not.toBe("cancelled_before_dial");
  });

  it("cleans up an unknown first dial once its late call.initiated arrives", async () => {
    const t = world();
    t.h.telnyx.loseNextResponse("dial");
    await expect(start(t, "outbound")).rejects.toMatchObject({ status: 503, code: "provider_outcome_unknown" });
    const [session] = t.h.rows("motorist_call_sessions") as SessionRow[];
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "on_call", current_session_id: session.id });
    await t.terminate(session.id);
    // The provider did create the operator's leg; its first event arrives after the hangup.
    const [own] = [...t.h.telnyx.physical.legs.keys()];
    const dial = t.h.telnyx.of("dial")[0];
    expect((await t.h.process(t.h.envelope("call.initiated", { call_control_id: own, call_leg_id: `leg-${own}`, call_session_id: `tsess-${own}`,
      client_state: dial.params.clientState, to: dial.params.to, from: dial.params.from, direction: "outgoing" }))).outcome).toBe("processed");
    expect(t.h.telnyx.physical.legs.get(own)?.ended).toBe(true);
    expect(t.h.session(session.id)).toMatchObject({ state: "ended", ended_at: expect.any(String) });
    expect(t.h.presence(actor.profileId)).toMatchObject({ status: "available", current_session_id: null });
    expect(t.releases.filter(release => release.sessionId === session.id && release.applied)).toHaveLength(1);
  });

  it("leaves a call that dialled before the hangup to the ordinary termination", async () => {
    const t = world();
    const call = await start(t, "outbound");
    await t.terminate(call.sessionId);
    // A retried POST of the same request must not rewrite the dialled call as cancelled.
    await expect(start(t, "outbound")).rejects.toMatchObject({ status: 409, code: "initial_call_ended" });
    expect(t.h.telnyx.of("dial")).toHaveLength(1);
    expect(t.h.session(call.sessionId)).toMatchObject({ state: "received", ended_at: null });
    expect(t.h.call(call.sessionId)?.end_reason ?? null).not.toBe("cancelled_before_dial");
  });
});
