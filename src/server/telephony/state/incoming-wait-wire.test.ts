import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingFlow, IncomingWaitPolicy } from "@/lib/telephony/incoming-flow";
import { callbackOrigin } from "@/lib/telephony/callback-origin";
import { CONNECTION_ID, createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { createTelnyxClient } from "../telnyx/client";
import { decodeClientState } from "../telnyx/client-state";
import { replayDeferredSessionEvents } from "../telnyx/event-processor";
import { runSessionEvent } from "../session-runner";
import { parkCall, pickupWaitingCall } from "../call-actions";
import { readMeta, type CallbackPlan, type SessionRow } from "./types";

// The ordinary harness mocks Telnyx methods. These tests instead run the actual
// HTTP adapter and contract-2 journal, so a lost camelCase field or a colliding
// command body cannot be hidden by that mock. Only the HTTP transport is fake.
// Contract references (checked 2026-10-04):
// https://developers.telnyx.com/api-reference/call-commands/gather
// https://developers.telnyx.com/api-reference/call-commands/gather-using-speak
// https://developers.telnyx.com/api-reference/call-commands/gather-using-audio
type WireCall = { action: string; body: Record<string, unknown> };

/** Provider behavior measured on real TEST calls on 2026-10-05: a gather
 * queued after a running MOH file starts its timer after that 22.056 s file;
 * a gather armed first runs concurrently with subsequently started playback.
 * Completion payloads contain the latest call-wide state, not command state.
 */
function mediaClock(h: ReturnType<typeof createTelephonyHarness>) {
  type Playback = { start: number; nextEnd: number; url: string };
  type Gather = { started: number; due: number };
  const legs = new Map<string, { state: unknown; music?: Playback; gather?: Gather }>();
  const prompts: Array<{ at: number; action: string; body: Record<string, unknown> }> = [];
  const music: Array<{ at: number; callControlId: string }> = [];
  const completions: Array<{ at: number; started: number }> = [];
  const legFor = (cc: string) => {
    let leg = legs.get(cc);
    if (!leg) { leg = { state: undefined }; legs.set(cc, leg); }
    return leg;
  };
  function accept(cc: string, action: string, body: Record<string, unknown>) {
    const leg = legFor(cc), now = h.now().getTime();
    if (body.client_state !== undefined) leg.state = body.client_state;
    if (action === "playback_stop") delete leg.music;
    if (action === "gather_stop") delete leg.gather;
    if (action === "hangup") { delete leg.music; delete leg.gather; }
    if (action === "playback_start" && String(body.audio_url).includes("/moh.mp3")) {
      leg.music = { start: now, nextEnd: now + 22_056, url: String(body.audio_url) };
      music.push({ at: now, callControlId: cc });
    }
    if (action === "gather") {
      leg.gather = { started: now, due: Math.max(now, leg.music?.nextEnd ?? now) + Number(body.initial_timeout_millis ?? 5_000) };
    }
    if (action === "gather_using_speak" || action === "gather_using_audio") {
      prompts.push({ at: now, action, body });
      // Both shipped prompts finish before the configured gap. Exact prompt
      // duration is independent of the provider queue bug under regression.
      const promptMillis = action === "gather_using_speak" ? 8_000 : 1_000;
      leg.gather = { started: now, due: now + promptMillis + Number(body.timeout_millis ?? 60_000) };
    }
  }
  async function next() {
    const scheduled = [...legs].flatMap(([cc, leg]) => [
      ...(leg.gather ? [{ cc, at: leg.gather.due, kind: "gather" as const }] : []),
      ...(leg.music ? [{ cc, at: leg.music.nextEnd, kind: "music" as const }] : []),
    ]).sort((a, b) => a.at - b.at)[0];
    if (!scheduled) throw new Error("No provider event is scheduled");
    h.advance(Math.max(0, scheduled.at - h.now().getTime()));
    h.touchDevice(PROFILES.o1);
    const leg = legFor(scheduled.cc), state = leg.state;
    if (scheduled.kind === "gather") {
      completions.push({ at: scheduled.at, started: leg.gather!.started });
      delete leg.gather;
      await h.legEvent(scheduled.cc, "call.gather.ended", { status: "timeout", digits: "", client_state: state });
    } else {
      const current = leg.music!;
      current.nextEnd += 22_056;
      await h.legEvent(scheduled.cc, "call.playback.ended", { status: "completed", media_url: current.url, client_state: state });
    }
    return scheduled;
  }
  return { accept, next, prompts, music, completions,
    state: (cc: string) => legFor(cc).state,
    gatherDue: (cc: string) => legFor(cc).gather?.due,
    endGather: (cc: string) => { delete legFor(cc).gather; },
  };
}
beforeEach(() => {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network forbidden in waiting wire QA"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function setup(policy: IncomingWaitPolicy, minutes = 2, writerContract: 1 | 2 = 2) {
  const h = createTelephonyHarness({ ...(writerContract === 2 ? { writerContract: 2 as const } : {}), sweepAfterEvent: false });
  const flow: IncomingFlow = { version: 1, ending: "hangup", steps: [
    { id: "00000000-0000-4000-8000-000000007811", type: "wait", minutes, policy },
    { id: "00000000-0000-4000-8000-000000007812", type: "ring", seconds: 20,
      people: [{ profileId: PROFILES.o1, application: true, personalNumber: null }] },
  ] };
  h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: flow } }, row => row.id === LINES.allianz);
  h.db.registerRpc("motorist_create_callback_obligation_v1", args => {
    const plan = args.p_plan as CallbackPlan;
    return h.rows("motorist_callback_requests").find(row => row.session_id === args.p_session_id) ?? h.db.insert("motorist_callback_requests", {
      organization_id: args.p_organization_id, session_id: args.p_session_id, caller_number: plan.callerNumber,
      source: plan.source, status: "open", metadata: plan.request ? { request: plan.request } : {},
    })[0];
  });
  const calls: WireCall[] = [];
  const clock = mediaClock(h);
  let rejectAudio = false;
  let musicFailure: { status: number; remaining: number } | null = null;
  let stopFailure: { status: number; remaining: number } | null = null;
  h.deps.telnyx = createTelnyxClient({ config: h.deps.config, liveGate: { callsEnabled: true, smsEnabled: false },
    now: () => h.now().getTime(), sleep: async ms => { h.advance(ms); },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://telnyx.test");
      expect(init?.method).toBe("POST");
      const action = url.pathname.split("/").at(-1)!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ action, body });
      if (rejectAudio && action === "gather_using_audio") {
        rejectAudio = false;
        return Response.json({ errors: [{ code: "10015", detail: "Audio URL is unavailable" }] }, { status: 422 });
      }
      if (musicFailure && musicFailure.remaining > 0 && action === "playback_start" && String(body.audio_url).includes("moh")) {
        musicFailure.remaining--;
        return Response.json({ errors: [{ code: "10015", detail: "Music unavailable" }] }, { status: musicFailure.status });
      }
      if (stopFailure && stopFailure.remaining > 0 && action === "playback_stop") {
        stopFailure.remaining--;
        return Response.json({ errors: [{ code: "10015", detail: "Injected playback stop failure" }] }, { status: stopFailure.status });
      }
      if (action === "calls") return Response.json({ data: { call_control_id: `cc-operator-${calls.length}`, call_leg_id: `leg-${calls.length}`, call_session_id: `ts-${calls.length}`, is_alive: true } });
      clock.accept(decodeURIComponent(url.pathname.split("/").at(-3)!), action, body);
      return Response.json({ data: { result: "ok" } });
    },
  });
  const lastGather = () => calls.filter(call => ["gather", "gather_using_audio", "gather_using_speak"].includes(call.action)).at(-1)!;
  const complete = (cc: string, digits = "", state = lastGather().body.client_state) => h.legEvent(cc, "call.gather.ended", {
    client_state: state, status: digits ? "valid" : "timeout", digits,
    gather_id: "provider-generated-id", // Runtime correlates its signed client_state, not an assumed provider id.
  });
  return { h, calls, clock, lastGather, complete, rejectNextAudio: () => { rejectAudio = true; },
    rejectNextMusic: (status = 422, attempts = 1) => { musicFailure = { status, remaining: attempts }; },
    rejectNextStop: (status = 422, attempts = 1) => { stopFailure = { status, remaining: attempts }; },
    inbound: () => h.inbound({ to: NUMBERS.allianz }),
    meta: (sid: string) => readMeta(h.session(sid) as SessionRow),
  };
}

describe("waiting flow through real Telnyx HTTP adapter", () => {
  it.each(["http", "webhook", "latest_gather_state"] as const)("retries music after a definite %s failure at the next tick without extending the wait", async failure => {
    const { h, calls, inbound, complete, lastGather, rejectNextMusic, meta } = setup({ mode: "music", intervalSeconds: 30 }, 5);
    if (failure === "http") rejectNextMusic();
    const call = await inbound();
    const startedAt = meta(call.sessionId).waiting?.since;
    const music = () => calls.filter(item => item.action === "playback_start" && String(item.body.audio_url).includes("moh"));
    if (failure !== "http") await h.legEvent(call.callControlId, "call.playback.ended", { status: "failed", media_url: music()[0].body.audio_url,
      client_state: failure === "latest_gather_state" ? lastGather().body.client_state : music()[0].body.client_state });
    expect(music()).toHaveLength(1); // No rapid retry loop on a broken asset.
    h.advance(60_000); await complete(call.callControlId);
    expect(music()).toHaveLength(2);
    expect(music()[1].body.command_id).not.toBe(music()[0].body.command_id);
    expect(meta(call.sessionId).waiting?.since).toBe(startedAt);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "failed", media_url: music()[0].body.audio_url, client_state: music()[0].body.client_state });
    const stale = h.envelope("call.playback.ended", { call_control_id: call.callControlId, status: "failed", media_url: music()[0].body.audio_url, client_state: lastGather().body.client_state });
    stale.data.occurred_at = startedAt; // Even newer call-wide state does not make an earlier loop's failure current.
    await h.process(stale);
    h.advance(60_000); await complete(call.callControlId);
    expect(music()).toHaveLength(2); // Successful infinite playback is not restarted each minute.
  });

  it("bounds retries even if the caller presses one repeatedly and never changes the original deadline", async () => {
    const { h, calls, inbound, complete, rejectNextMusic, meta } = setup({ mode: "music", intervalSeconds: 30 }, 5);
    rejectNextMusic(422, 10);
    const call = await inbound();
    const startedAt = meta(call.sessionId).waiting?.since;
    for (let press = 0; press < 120; press++) { h.advance(1_000); await complete(call.callControlId, "1"); }
    const attempts = calls.filter(item => item.action === "playback_start" && String(item.body.audio_url).includes("moh"));
    expect(attempts).toHaveLength(3); // t=0, 60s, 120s; not 120 restarts.
    expect(new Set(attempts.map(item => item.body.command_id)).size).toBe(3);
    expect(meta(call.sessionId).waiting?.since).toBe(startedAt);
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it.each([1, 2] as const)("does not retry a fresh music command after an ambiguous provider timeout with writer contract %s", async contract => {
    const { h, calls, inbound, rejectNextMusic, meta } = setup({ mode: "music", intervalSeconds: 30 }, 5, contract);
    rejectNextMusic(408, 10);
    const call = await inbound();
    expect(meta(call.sessionId).waiting?.music?.retry_at).toBeUndefined();
    h.advance(60_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    const attempts = calls.filter(item => item.action === "playback_start" && String(item.body.audio_url).includes("moh"));
    expect(new Set(attempts.map(item => item.body.command_id)).size).toBe(1);
  });

  it("ignores music failure after the wait advances, including after the next operator answers", async () => {
    const { h, calls, inbound, complete, rejectNextMusic } = setup({ mode: "music", intervalSeconds: 30 }, 1);
    rejectNextMusic();
    const call = await inbound();
    const music = calls.find(item => item.action === "playback_start" && String(item.body.audio_url).includes("moh"))!;
    h.advance(60_000); h.touchDevice(PROFILES.o1); await complete(call.callControlId);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "failed", media_url: music.body.audio_url, client_state: music.body.client_state });
    expect(h.session(call.sessionId).state).toBe("ringing");
    const operator = h.openLegFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(operator.telnyx_call_control_id), "call.answered");
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "failed", media_url: music.body.audio_url, client_state: music.body.client_state });
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(calls.filter(item => item.action === "playback_start" && String(item.body.audio_url).includes("moh"))).toHaveLength(1);
    // The pre-existing music recovery for an answered call parked by its
    // operator remains separate from the bounded incoming waiting policy.
    await parkCall(h.deps, { profileId: PROFILES.o1, role: "dispatcher" }, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("parked");
    const parkedMusic = calls.findLast(item => item.action === "playback_start" && String(item.body.audio_url).includes("moh"))!;
    const before = calls.length;
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "failed", media_url: parkedMusic.body.audio_url, client_state: parkedMusic.body.client_state });
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.at(-1)?.action).toBe("playback_start");
  });

  it.each([1, 5, 15])("runs a %s-minute music wait as bounded provider gathers and then advances once", async minutes => {
    const { h, calls, inbound, lastGather, complete, meta } = setup({ mode: "music", intervalSeconds: 30 }, minutes);
    const call = await inbound();
    const firstState = lastGather().body.client_state;
    for (let minute = 0; minute < minutes; minute++) {
      expect(lastGather()).toMatchObject({ action: "gather", body: {
        maximum_digits: 1, valid_digits: "0123456789#*", timeout_millis: 60_000, initial_timeout_millis: 60_000,
      } });
      expect(decodeClientState(String(lastGather().body.client_state))).toMatchObject({ intent: "queue_wait", sid: call.sessionId, gatherId: expect.any(String) });
      h.advance(60_000); h.touchDevice(PROFILES.o1);
      await complete(call.callControlId);
    }
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(calls.filter(item => item.action === "calls")).toHaveLength(1);
    expect(calls.filter(item => item.action === "gather")).toHaveLength(minutes);
    expect(calls.filter(item => item.action === "playback_start" && String(item.body.audio_url).includes("moh"))).toHaveLength(1);
    expect(new Set(calls.map(item => item.body.command_id)).size).toBe(calls.length);
    await complete(call.callControlId, "1", firstState);
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(meta(call.sessionId).journey?.entries.filter(entry => entry.kind === "step_exit" && entry.stepIndex === 0)).toHaveLength(1);
  });

  it.each([15, 30, 60] as const)("sends localized callback speech and a %s-second gap, accepts one request, then closes", async intervalSeconds => {
    const { h, calls, inbound, lastGather, complete, meta } = setup({ mode: "callback", intervalSeconds });
    const call = await inbound();
    expect(lastGather()).toMatchObject({ action: "gather_using_speak", body: {
      payload: expect.stringContaining("jednotku"), voice: "Azure.sk-SK-LukasNeural", maximum_tries: 1,
      maximum_digits: 1, valid_digits: "1", timeout_millis: 1_000,
    } });
    expect(lastGather().body).not.toHaveProperty("audio_url");
    expect(lastGather().body).not.toHaveProperty("language"); // Locale belongs to the Azure voice; sk-SK is not a gather language enum.
    h.advance(8_000); await complete(call.callControlId);
    expect(lastGather()).toMatchObject({ action: "gather", body: { timeout_millis: intervalSeconds * 1_000, initial_timeout_millis: intervalSeconds * 1_000 } });
    const oldMusicState = lastGather().body.client_state;
    h.advance(intervalSeconds * 1_000); await complete(call.callControlId);
    expect(calls.slice(-2).map(item => item.action)).toEqual(["playback_stop", "gather_using_speak"]);
    const currentState = lastGather().body.client_state;
    await complete(call.callControlId, "1", oldMusicState);
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    await complete(call.callControlId, "1", currentState);
    await complete(call.callControlId, "1", currentState);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(meta(call.sessionId).callback).toMatchObject({ confirmed: true, digit: "1", context: "waiting_room" });
    const confirmation = calls.findLast(item => item.action === "playback_start" && decodeClientState(String(item.body.client_state))?.intent === "callback_confirmation")!;
    expect(confirmation).toBeDefined();
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: confirmation.body.client_state });
    expect(calls.at(-1)?.action).toBe("hangup");
    expect(calls.filter(item => item.action === "calls")).toHaveLength(0);
  });

  it.each(["prompt", "music"] as const)("accepts the caller's bare DTMF during %s even if the gather later reports an empty timeout", async phase => {
    const { h, calls, inbound, complete, lastGather, meta } = setup({ mode: "callback", intervalSeconds: 15 });
    const call = await inbound();
    if (phase === "music") { h.advance(8_000); await complete(call.callControlId); }
    const state = lastGather().body.client_state;
    const count = calls.length;
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "completed", client_state: state });
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(calls).toHaveLength(count);
    h.advance(250);
    const requestedAt = h.now().toISOString();
    await h.legEvent(call.callControlId, "call.dtmf.received", { digit: "1", client_state: state }, "caller-one");
    const afterChoice = calls.length;
    await h.legEvent(call.callControlId, "call.dtmf.received", { digit: "1", client_state: state }, "caller-one");
    await h.legEvent(call.callControlId, "call.dtmf.received", { digit: "1", client_state: state });
    h.advance(15_000);
    await complete(call.callControlId, "", state); // Exact failure observed on the real Telnyx music gather.
    await complete(call.callControlId, "1", state); // A valid completion must not confirm twice either.
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(calls).toHaveLength(afterChoice);
    const request = h.rows("motorist_callback_requests")[0];
    expect(callbackOrigin(String(request.source), request.metadata)).toEqual({
      kind: "requested", requestedAt, digit: "1", context: "waiting_room", evidence: "dtmf",
    });
    expect(meta(call.sessionId).journey?.entries.filter(entry => entry.reason === "callback_requested")).toHaveLength(1);
    expect(calls.filter(item => item.action === "gather_stop")).toHaveLength(1);
    const confirmations = calls.filter(item => item.action === "playback_start" && decodeClientState(String(item.body.client_state))?.intent === "callback_confirmation");
    expect(confirmations).toHaveLength(1);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: confirmations[0].body.client_state });
    expect(calls.at(-1)?.action).toBe("hangup");
    expect(calls.filter(item => item.action === "calls")).toHaveLength(0);
  });

  it.each([1, 2] as const)("persists a retried DTMF choice before confirmation with writer contract %s", async contract => {
    const { h, calls, inbound, lastGather } = setup({ mode: "callback", intervalSeconds: 15 }, 2, contract);
    const call = await inbound();
    const state = lastGather().body.client_state;
    const callbackRpc = h.db.rpcHandlers.get("motorist_create_callback_obligation_v1")!;
    let fail = true;
    h.db.registerRpc("motorist_create_callback_obligation_v1", (args, db) => {
      if (fail) throw new Error("Injected callback write failure");
      return callbackRpc(args, db);
    });
    const event = h.envelope("call.dtmf.received", { call_control_id: call.callControlId, call_session_id: call.telnyxSessionId, digit: "1", client_state: state }, "durable-caller-one");
    const confirmations = () => calls.filter(item => item.action === "playback_start" && decodeClientState(String(item.body.client_state))?.intent === "callback_confirmation");
    await h.process(event);
    expect(h.session(call.sessionId).metadata).toMatchObject({ callback: { confirmed: true, digit: "1", event_id: "durable-caller-one" } });
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(confirmations()).toHaveLength(0);
    fail = false;
    h.advance(60_000);
    await h.process(event);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    // Contract 1 may resend after replaying its cursor; Telnyx deduplicates the
    // identical command. Contract 2 journals the acknowledged HTTP delivery.
    expect(new Set(confirmations().map(item => item.body.command_id)).size).toBe(1);
    const deliveries = confirmations().length;
    if (contract === 2) expect(deliveries).toBe(1);
    await h.process(event);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(confirmations()).toHaveLength(deliveries);
  });

  it.each([false, true])("drains deferred DTMF before an empty gather timeout, while caller hangup wins (%s)", async hungUp => {
    const { h, calls, inbound, complete, lastGather } = setup({ mode: "callback", intervalSeconds: 15 });
    const call = await inbound();
    h.advance(8_000); await complete(call.callControlId);
    const state = lastGather().body.client_state;
    h.advance(1_000);
    const row = { organization_id: ORG, call_session_id: call.telnyxSessionId, call_control_id: call.callControlId, connection_id: CONNECTION_ID,
      status: "failed", retry_state: "deferred", attempts: 1, delivery_count: 1, deferral_count: 1, effect_failure_count: 0, contract_version: 2,
      claimed_at: null, next_attempt_at: h.now().toISOString(), received_at: h.now().toISOString(), occurred_at: h.now().toISOString() };
    h.db.insert("motorist_telnyx_webhook_events", [
      { ...row, event_id: "deferred-timeout", event_type: "call.gather.ended", payload: { status: "timeout", digits: "", client_state: state } },
      { ...row, event_id: "deferred-one", event_type: "call.dtmf.received", payload: { digit: "1", client_state: state } },
      ...(hungUp ? [{ ...row, event_id: "deferred-hangup", event_type: "call.hangup", payload: { hangup_cause: "normal_clearing", client_state: state } }] : []),
    ]);
    const mark = h.db.log.length;
    await replayDeferredSessionEvents(h.deps, call.sessionId);
    await replayDeferredSessionEvents(h.deps, call.sessionId); // Each retained drain is deliberately bounded.
    expect(h.db.log.slice(mark).filter(entry => entry.table === "motorist_telnyx_claim_webhook_event_v2").map(entry => (entry.payload as { p_event_id: string }).p_event_id))
      .toEqual([...(hungUp ? ["deferred-hangup"] : []), "deferred-one", "deferred-timeout"]);
    expect(h.rows("motorist_callback_requests").filter(row => callbackOrigin(String(row.source), row.metadata).kind === "requested")).toHaveLength(hungUp ? 0 : 1);
    expect(calls.filter(item => item.action === "playback_start" && decodeClientState(String(item.body.client_state))?.intent === "callback_confirmation")).toHaveLength(hungUp ? 0 : 1);
  });

  it("retains announcement-only policy across a provider 422 fallback and watchdog recovery", async () => {
    const { h, calls, inbound, complete, lastGather, rejectNextAudio, meta } = setup({ mode: "announcement", intervalSeconds: 15 }, 5);
    rejectNextAudio();
    const call = await inbound();
    expect(calls.filter(item => item.action.startsWith("gather"))).toMatchObject([
      { action: "gather_using_audio", body: { audio_url: expect.stringContaining("holdReminder.mp3") } },
      { action: "gather_using_speak", body: { payload: "Ďakujeme, že čakáte.", valid_digits: "0123456789#*" } },
    ]);
    expect(meta(call.sessionId).gather?.id).toBe(decodeClientState(String(lastGather().body.client_state))?.gatherId);
    await complete(call.callControlId, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    h.advance(50_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(lastGather()).toMatchObject({ action: "gather", body: { valid_digits: "0123456789#*", initial_timeout_millis: 15_000 } });
    await complete(call.callControlId, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe("waiting");
  });

  it.each((["callback", "announcement"] as const).flatMap(mode => ([15, 30, 60] as const).map(intervalSeconds => ({ mode, intervalSeconds }))))(
    "repeats $mode prompts after each $intervalSeconds-second audible music gap through the provider queue", async policy => {
      const { h, clock, inbound, meta } = setup(policy, 5);
      const call = await inbound();
      for (let cycle = 0; cycle < 3; cycle++) {
        await clock.next(); // Spoken prompt's own completion starts this gap.
        const musicStarted = h.now().getTime();
        expect(clock.music.at(-1)?.at).toBe(musicStarted); // No gather-length silence before the music.
        expect(clock.gatherDue(call.callControlId)).toBe(musicStarted + policy.intervalSeconds * 1_000);
        while (clock.prompts.length < cycle + 2) {
          await clock.next(); // Also emits normal completed events for each infinite-loop iteration.
          expect(meta(call.sessionId).waiting?.music?.retry_at).toBeUndefined();
        }
        expect(clock.prompts.at(-1)?.at).toBe(musicStarted + policy.intervalSeconds * 1_000);
      }
      expect(clock.prompts).toHaveLength(4);
      expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    },
  );

  it("repeats in two successive waiting rooms with independent cadence and advances each exactly once", async () => {
    const { h, calls, clock, inbound, meta } = setup({ mode: "callback", intervalSeconds: 15 }, 1);
    const flow: IncomingFlow = { version: 1, ending: "hangup", steps: [
      { id: "00000000-0000-4000-8000-000000007821", type: "wait", minutes: 1, policy: { mode: "callback", intervalSeconds: 15 } },
      { id: "00000000-0000-4000-8000-000000007822", type: "wait", minutes: 1, policy: { mode: "announcement", intervalSeconds: 15 } },
      { id: "00000000-0000-4000-8000-000000007823", type: "ring", seconds: 20, people: [{ profileId: PROFILES.o1, application: true, personalNumber: null }] },
    ] };
    h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: flow } }, row => row.id === LINES.allianz);
    const call = await inbound(), started = h.now().getTime(), firstState = clock.state(call.callControlId);
    for (let count = 0; h.session(call.sessionId).current_step === 1 && count < 20; count++) await clock.next();
    expect(h.now().getTime()).toBe(started + 60_000);
    expect(meta(call.sessionId).waiting).toMatchObject({ since: new Date(started + 60_000).toISOString(), ticks: 0,
      flow_step_index: 1, audio_policy: { mode: "announcement", intervalSeconds: 15 } });
    expect(clock.state(call.callControlId)).not.toBe(firstState);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "valid", digits: "1", client_state: firstState });
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    for (let count = 0; h.session(call.sessionId).state === "waiting" && count < 20; count++) await clock.next();
    expect(h.now().getTime()).toBe(started + 120_000);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(clock.prompts.filter(prompt => prompt.action === "gather_using_speak")).toHaveLength(3);
    expect(clock.prompts.filter(prompt => prompt.action === "gather_using_audio")).toHaveLength(4);
    expect(calls.filter(item => item.action === "calls")).toHaveLength(1);
    for (const stepIndex of [0, 1]) expect(meta(call.sessionId).journey?.entries.filter(entry => entry.kind === "step_exit" && entry.stepIndex === stepIndex)).toHaveLength(1);
  });

  it("bounds the final music gap by the remaining wait deadline rather than the music file length", async () => {
    const { h, calls, clock, inbound, complete, meta } = setup({ mode: "callback", intervalSeconds: 15 }, 1);
    const call = await inbound(), started = h.now().getTime();
    h.advance(56_500); // A delayed prompt completion leaves only 3.5 seconds in this waiting step.
    clock.endGather(call.callControlId);
    await complete(call.callControlId);
    const oldState = clock.state(call.callControlId);
    expect(clock.gatherDue(call.callControlId)).toBe(started + 60_000);
    await clock.next();
    expect(h.now().getTime()).toBe(started + 60_000);
    expect(h.session(call.sessionId).state).toBe("ringing");
    const count = calls.length;
    await complete(call.callControlId, "", oldState);
    await h.legEvent(call.callControlId, "call.dtmf.received", { digit: "1", client_state: oldState });
    expect(calls).toHaveLength(count);
    expect(meta(call.sessionId).waiting).toBeNull();
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it.each(["callback", "announcement"] as const)("re-arms %s after an ignored digit without adding the playing file to the remaining gap", async mode => {
    const { h, clock, inbound, meta } = setup({ mode, intervalSeconds: 15 });
    const call = await inbound();
    await clock.next();
    const until = meta(call.sessionId).waiting?.music_until;
    const state = clock.state(call.callControlId), digit = mode === "callback" ? "2" : "1";
    h.advance(4_000);
    await h.legEvent(call.callControlId, "call.dtmf.received", { digit, client_state: state });
    clock.endGather(call.callControlId);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: mode === "callback" ? "invalid" : "valid", digits: digit, client_state: state });
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(meta(call.sessionId).waiting?.music_until).toBe(until);
    expect(clock.gatherDue(call.callControlId)).toBe(Date.parse(until!));
    await clock.next();
    expect(clock.prompts).toHaveLength(2);
    expect(clock.prompts[1].at).toBe(Date.parse(until!));
  });

  it("retains the active callback gather state after starting music and confirms bare DTMF exactly once", async () => {
    const { h, calls, clock, inbound, lastGather } = setup({ mode: "callback", intervalSeconds: 15 });
    const call = await inbound();
    await clock.next();
    const actualState = clock.state(call.callControlId);
    expect(actualState).toBe(lastGather().body.client_state);
    h.advance(1_000);
    await h.legEvent(call.callControlId, "call.dtmf.received", { digit: "1", client_state: actualState });
    const count = calls.length;
    await h.legEvent(call.callControlId, "call.dtmf.received", { digit: "1", client_state: actualState });
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "cancelled", digits: "", client_state: actualState });
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", digits: "", client_state: actualState });
    expect(calls).toHaveLength(count);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(calls.filter(item => item.action === "playback_start" && decodeClientState(String(item.body.client_state))?.intent === "callback_confirmation")).toHaveLength(1);
  });

  it("preserves a callback music failure's backoff across repeated ignored digits", async () => {
    const { h, calls, clock, inbound, rejectNextMusic, meta } = setup({ mode: "callback", intervalSeconds: 60 }, 5);
    const call = await inbound();
    const since = meta(call.sessionId).waiting?.since;
    rejectNextMusic(422, 2);
    await clock.next();
    const retryAt = meta(call.sessionId).waiting?.music?.retry_at;
    const until = meta(call.sessionId).waiting?.music_until;
    expect(retryAt).toBe(new Date(h.now().getTime() + 60_000).toISOString());
    for (let digit = 0; digit < 59; digit++) {
      h.advance(1_000);
      const state = clock.state(call.callControlId);
      clock.endGather(call.callControlId);
      await h.legEvent(call.callControlId, "call.gather.ended", { status: "invalid", digits: "2", client_state: state });
      expect(meta(call.sessionId).waiting?.music?.retry_at).toBe(retryAt);
      expect(meta(call.sessionId).waiting?.music_until).toBe(until);
    }
    const musicCommands = () => calls.filter(item => item.action === "playback_start" && String(item.body.audio_url).includes("/moh.mp3"));
    expect(musicCommands()).toHaveLength(1);
    expect(meta(call.sessionId).waiting?.since).toBe(since);
    await clock.next(); // The original gap ends; the next prompt is still offered normally.
    expect(clock.prompts).toHaveLength(2);
    await clock.next();
    expect(musicCommands()).toHaveLength(2);
    expect(meta(call.sessionId).waiting?.since).toBe(since);
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it("clears an ambiguous music dispatch before rearming the same interval", async () => {
    const { h, calls, clock, inbound, rejectNextMusic, meta } = setup({ mode: "callback", intervalSeconds: 60 }, 5);
    const call = await inbound();
    rejectNextMusic(408, 20);
    await clock.next();
    const state = clock.state(call.callControlId);
    expect(meta(call.sessionId).waiting?.music?.retry_at).toBeUndefined();
    const until = meta(call.sessionId).waiting?.music_until;
    rejectNextMusic(408, 0);
    h.advance(1_000);
    clock.endGather(call.callControlId);
    const before = calls.length;
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "invalid", digits: "2", client_state: state });
    expect(calls.slice(before).map(item => item.action)).toEqual(["playback_stop", "gather", "playback_start"]);
    expect(meta(call.sessionId).waiting?.music_until).toBe(until);
    expect(clock.gatherDue(call.callControlId)).toBe(Date.parse(until!));
  });

  it.each([422, 408])("blocks timer and music rearming when playback stop fails with HTTP %s", async status => {
    const { h, calls, clock, inbound, rejectNextStop, meta } = setup({ mode: "callback", intervalSeconds: 60 }, 5);
    const call = await inbound();
    await clock.next();
    h.advance(1_000);
    const state = clock.state(call.callControlId), until = meta(call.sessionId).waiting?.music_until;
    clock.endGather(call.callControlId);
    rejectNextStop(status, 20);
    const event = h.envelope("call.gather.ended", { call_control_id: call.callControlId, call_session_id: call.telnyxSessionId,
      status: "invalid", digits: "2", client_state: state }, `blocked-stop-${status}`);
    const before = calls.length;
    await h.process(event);
    const attempts = calls.slice(before);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every(item => item.action === "playback_stop")).toBe(true);
    expect(new Set(attempts.map(item => item.body.command_id)).size).toBe(1);
    expect(meta(call.sessionId).waiting?.music_until).toBe(until);
    if (status === 408) {
      rejectNextStop(408, 0);
      // The workflow fake deliberately never redispatches journal entries.
      // Supply authoritative acknowledgement of this exact stop, as provider
      // reconciliation does, then let the retained command cursor continue.
      const stopped = attempts[0];
      h.db.update("motorist_provider_commands", { outcome: "accepted", http_status: 200, result: { data: { result: "ok" } } },
        row => row.session_id === call.sessionId && row.command_id === stopped.body.command_id);
      clock.accept(call.callControlId, "playback_stop", stopped.body);
      const retryFrom = calls.length;
      h.advance(30_000);
      await h.process(event);
      expect(calls.slice(retryFrom).map(item => item.action)).toEqual(["gather", "playback_start"]);
      expect(meta(call.sessionId).waiting?.music_until).toBe(until);
    }
  });

  it.each(["pickup", "hangup"] as const)("does not resume a prompt when %s wins just before the music timer ends", async winner => {
    const { h, calls, clock, inbound, complete } = setup({ mode: "callback", intervalSeconds: 15 });
    const call = await inbound();
    await clock.next();
    const state = clock.state(call.callControlId);
    h.advance(14_999);
    if (winner === "pickup") {
      await pickupWaitingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId);
      const operator = h.openLegFor(call.sessionId, PROFILES.o2)!;
      await h.legEvent(String(operator.telnyx_call_control_id), "call.answered");
    } else await h.legEvent(call.callControlId, "call.hangup", { client_state: state });
    const count = calls.length;
    h.advance(1);
    await complete(call.callControlId, "", state);
    expect(h.session(call.sessionId).state).toBe(winner === "pickup" ? "talking" : "ended");
    expect(calls).toHaveLength(count);
    expect(h.rows("motorist_callback_requests").filter(row => callbackOrigin(String(row.source), row.metadata).kind === "requested")).toHaveLength(0);
  });
});
