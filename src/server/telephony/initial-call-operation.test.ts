import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { startOutboundCall, createRateLimiter, type CallActor } from "./call-actions";
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
    t.h.db.failNext("motorist_call_events", "insert", "audit unavailable");
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
