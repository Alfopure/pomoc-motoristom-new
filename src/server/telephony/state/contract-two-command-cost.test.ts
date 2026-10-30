import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { delayDatabase, WAVE_MS, type DatabaseDelay } from "@/test/delay-database";
import { changeNativeHold } from "@/server/mobile/voice-hold";
import { blindTransfer, callColleague, createRateLimiter, hangupCall, holdCall, startOutboundCall, unholdCall } from "../call-actions";
import type { TelephonyRuntimeDeps } from "../runtime";
import { readPendingEffects } from "./continuation";
import { commandKey, readMeta } from "./types";
import type { SessionRow } from "./types";

/**
 * Dependent-wave bounds (suite below), measured on 30 Oct 2026 at `dev` 489dbd6
 * with S0. Waves count the database and provider round trips a step waits for
 * in sequence; requests count all of them. Later stages lower these.
 */
const BOUND = {
  outboundStart: { requests: 37, toOwnDial: 18, resolved: 31 },
  colleagueStart: { 1: { requests: 42, toOwnDial: 19, resolved: 32 }, 2: { requests: 43, toOwnDial: 19, resolved: 32 } },
  outboundOwnAnswer: { requests: 33, toCustomerDial: 12 },
  internalOwnAnswer: { 1: { requests: 41, toColleagueDial: 20 }, 2: { requests: 51, toColleagueDial: 20 } },
  internalCalleeAnswer: { requests: 37, toBridge: 18, toTalking: 9, toCalleeAnswered: 11 },
  firstBridged: { requests: 29, leases: 1 },
  duplicateBridged: { requests: 28, leases: 1 },
  knownInitiated: { requests: 24 },
  webHoldFirst: { requests: 35, waves: 31 },
  webHoldLater: { requests: 28, waves: 20 },
  nativeHoldFirst: { requests: 69, waves: 65 },
  nativeHoldLater: { requests: 57, waves: 49 },
} as const;

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

/** Contract 2 — generation leases and the fenced provider journal — is what production runs. */
function harness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
}

async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  await h.legEvent(winner, "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId)).toMatchObject({ state: "talking", writer_contract: 2 });
  return call;
}

const reads = (h: TelephonyHarness, from: number) =>
  h.db.log.slice(from).filter(row => row.table === "motorist_call_sessions" && row.operation === "select").length;

describe("contract 2 request cost", () => {
  it("stays inside the measured budget for every call action", async () => {
    const answerHarness = harness();
    const first = await answerHarness.inbound({ to: NUMBERS.allianz });
    const winner = String(answerHarness.legFor(first.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const answerFrom = answerHarness.db.log.length;
    await answerHarness.legEvent(winner, "call.answered");
    const answer = answerHarness.db.log.length - answerFrom;

    const h = harness();
    const call = await talking(h);
    const measure = async (run: () => Promise<unknown>) => {
      const from = h.db.log.length;
      await run();
      return h.db.log.length - from;
    };
    const hold = await measure(() => completeAnnouncedAction(h, holdCall(h.deps, actor, call.sessionId)));
    const unhold = await measure(() => completeAnnouncedAction(h, unholdCall(h.deps, actor, call.sessionId)));
    const transfer = await measure(() => completeAnnouncedAction(h, blindTransfer(h.deps, actor, call.sessionId, { number: NUMBERS.external })));
    const hangup = await measure(() => hangupCall(h.deps, actor, call.sessionId));

    // Measured on this path: 64 / 40 / 36 / 47 / 39 before the 17 Sep work,
    // 45 / 35 / 33 / 41 / 32 after it, 63 / 44 / 36 / 50 / 42 once the double
    // started going through the provider journal like the real client, and
    // 61 / 44 / 36 / 51 / 42 with one checkpoint per overlapping run, and
    // 55 for an answer once the lease renew was throttled to one per five
    // seconds — which needed the double to model the fence first, since the
    // fence is what refuses a stale owner when the renew no longer does — and
    // 51 once the journal batched — a run of teardown and a whole ring step
    // each fence and record once rather than twice per command — and 47 once
    // the critical phase wrote its session, legs and attempts in one call.
    //
    // The jump is not a regression. It is the cost that was always there and
    // never counted: `prepare_v2` before every voice command and `result_v2`
    // after it, two database round trips each. Everything measured before
    // 18 Sep understates production by roughly that much, including the
    // reductions this repair claimed.
    //
    // Bounds carry two requests of headroom because the throttled
    // incident-recovery read fires or not depending on wall-clock; they still
    // catch any regression of three or more. Guards, not targets — lower them
    // when a change lowers the count.
    expect(answer).toBeLessThanOrEqual(49);
    expect(hold).toBeLessThanOrEqual(46);
    expect(unhold).toBeLessThanOrEqual(38);
    expect(transfer).toBeLessThanOrEqual(52);
    expect(hangup).toBeLessThanOrEqual(44);
  });

  it("records why a command failed, not just that it did", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    // A best-effort stop: the call still connects, so the audit is written and
    // the failure is exactly the kind that used to leave no trace.
    h.telnyx.failNext("playbackStop", "Telnyx refused the playback stop");

    await h.legEvent(winner, "call.answered");

    expect(h.session(call.sessionId).state).toBe("talking");
    const audited = h.rows("motorist_call_events")
      .flatMap(row => ((row.normalized_payload as { commands?: { kind: string; ok: boolean; error?: string }[] } | null)?.commands) ?? [])
      .filter(command => !command.ok);
    expect(audited.map(command => command.kind)).toContain("playback_stop");
    expect(audited[0].error).toContain("Telnyx refused the playback stop");
    expect(audited.every(command => (command.error ?? "").length <= 300)).toBe(true);
  });

  it("validates later commands against the fenced row it already holds", async () => {
    const h = harness();
    const call = await talking(h);
    const from = h.db.log.length;

    await hangupCall(h.deps, actor, call.sessionId);

    expect(h.telnyx.of("hangup").length).toBeGreaterThanOrEqual(2);
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    // One read per provider command is what this removed; a couple of reads for
    // the action itself remain.
    expect(reads(h, from)).toBeLessThanOrEqual(5);
  });

  it("retires a command the fence refuses after a termination instead of compensating the call", async () => {
    const h = harness();
    const call = await talking(h);
    // What `prepare_v2` raises once another invocation has committed a
    // termination: `app.hangup` commits it before it waits for the lease.
    const refused = Object.assign(new Error("motorist_provider_command_prepare_v2: telephony termination blocks new provider command"), { code: "PT409" });
    // Once a termination is committed, `prepare_v2` refuses every non-teardown
    // command of the entry, not just the first.
    h.telnyx.failAlways("createConference", refused);
    h.telnyx.failAlways("conferenceAction", refused);
    const incidents = h.rows("motorist_job_incidents").length;

    const result = await completeAnnouncedAction(h, holdCall(h.deps, actor, call.sessionId)).catch(() => null);

    // The call is already ending, so the command is retired rather than turned
    // into an incident or a compensation putting the caller back anywhere.
    expect(h.rows("motorist_job_incidents")).toHaveLength(incidents);
    // Nothing is left half-issued for a replay to pick up either.
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries
      .every(entry => entry.commands.every(command => entry.completedCommands.includes(commandKey(command))))).toBe(true);
    void result;
  });

  it("still treats the same refusal on a teardown command as a real failure", async () => {
    const h = harness();
    const call = await talking(h);
    const refused = Object.assign(new Error("motorist_provider_command_prepare_v2: telephony termination blocks new provider command"), { code: "PT409" });
    h.telnyx.failAlways("hangup", refused as never);

    const result = await hangupCall(h.deps, actor, call.sessionId).catch(() => "threw" as const);

    // `prepare_v2` never refuses teardown after a termination — it is what lets
    // the call end. If it ever does, that is a failure to report, not a skip.
    expect(result === "threw" || result.commands.some(command => command.kind === "hangup" && !command.ok)).toBe(true);
  });

  it("keeps the fresh read while a call is being recorded", async () => {
    const recorded = harness();
    const one = await talking(recorded);
    const session = recorded.session(one.sessionId) as SessionRow;
    const meta = session.metadata as Record<string, unknown>;
    const recording = meta.recording as { policy: Record<string, unknown> };
    recorded.db.update("motorist_call_sessions",
      { metadata: { ...meta, recording: { ...recording, policy: { ...recording.policy, enabled: true } } } },
      row => row.id === one.sessionId);
    const recordedFrom = recorded.db.log.length;
    await hangupCall(recorded.deps, actor, one.sessionId);

    const plain = harness();
    const two = await talking(plain);
    const plainFrom = plain.db.log.length;
    await hangupCall(plain.deps, actor, two.sessionId);

    // Recording keeps its own live view of recorders and pending audio, so it
    // reads the session more often than a call without it. A count of its own
    // would only measure whatever the rest of the path costs this week.
    expect(reads(recorded, recordedFrom)).toBeGreaterThan(reads(plain, plainFrom));
  });


  it("reaches the provider within ten requests when an operator ends the call", async () => {
    const h = harness();
    const call = await talking(h);
    const from = h.db.log.length;
    let chain = -1;
    const client = h.telnyx.client as unknown as Record<string, (input: never) => Promise<unknown>>;
    const one = client.hangup.bind(h.telnyx.client);
    const many = client.callActionMany.bind(h.telnyx.client);
    const mark = () => { if (chain < 0) chain = h.db.log.length - from; };
    client.hangup = async (input: never) => { mark(); return one(input); };
    client.callActionMany = async (list: never) => { mark(); return many(list); };

    await hangupCall(h.deps, actor, call.sessionId);

    // The plan's acceptance criterion for the one command an operator most
    // wants to be instant. It was twelve: a session row read twice before the
    // lease, the offer-cancellation pass asking for its session and its legs
    // one after the other, and a checkpoint that wrote null over null.
    expect(chain).toBeGreaterThan(0);
    expect(chain).toBeLessThanOrEqual(10);
  });

  it("still clears a pending offer cancellation rather than skipping the write", async () => {
    const h = harness();
    const call = await talking(h);
    // A session that has something scheduled must still be written, or the
    // retry would be scheduled for ever.
    h.db.update("motorist_call_sessions", { cancellations_next_attempt_at: h.now().toISOString() }, (row) => row.id === call.sessionId);

    await hangupCall(h.deps, actor, call.sessionId);

    expect(h.session(call.sessionId).cancellations_next_attempt_at ?? null).toBeNull();
  });
});

/**
 * Request counts and dependent waves on the call-setup and hold paths (call-
 * speed plan S0.3). Every database request and provider command waits one
 * `WAVE_MS`, so elapsed time ÷ `WAVE_MS` is the chain a real round trip
 * multiplies. Each bound is the value measured on 30 Oct 2026 (`dev` 489dbd6
 * plus S0); later stages lower them and nothing may raise them. Request counts
 * keep the existing two of headroom for the throttled incident-recovery read.
 */
describe("contract 2 dependent waves", () => {
  const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const rateLimited = (h: TelephonyHarness) => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });

  type Metered<T> = { value: T; requests: number; leases: number; waves: number; meter: DatabaseDelay; sent: TelephonyHarness["telnyx"]["sent"] };
  async function metered<T>(h: TelephonyHarness, run: () => Promise<T>, watch: (meter: DatabaseDelay) => void = () => {}): Promise<Metered<T>> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const meter = delayDatabase(h);
    h.telnyx.setFetchDelay(WAVE_MS);
    try {
      watch(meter);
      const from = h.db.log.length, sentFrom = h.telnyx.sent.length;
      const pending = run();
      await vi.runAllTimersAsync();
      const value = await pending;
      const log = h.db.log.slice(from);
      return { value, requests: log.length, leases: log.filter(row => row.table === "motorist_session_lease_acquire_v2").length,
        waves: meter.waves(), meter, sent: h.telnyx.sent.slice(sentFrom) };
    } finally {
      meter.restore();
      h.telnyx.setFetchDelay(0);
      vi.useRealTimers();
    }
  }
  /** Waves until the `nth` (0-based) provider send of `method` in this measurement. */
  const sendWave = (run: Metered<unknown>, method: string, nth = 0) => {
    const send = run.sent.filter(entry => entry.method === method)[nth];
    if (!send) throw new Error(`no ${method} send #${nth}`);
    return run.meter.waves(send.at);
  };
  const markWave = (run: Metered<unknown>, name: string) => {
    if (!(name in run.meter.marks)) throw new Error(`${name} never held`);
    return run.meter.marks[name] / WAVE_MS;
  };
  /** At most the bound, and more than nothing: a broken meter must not pass as a fast path. */
  const bounded = (actual: number, max: number) => {
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBeLessThanOrEqual(max);
  };

  it("counts waves, not requests: parallel requests share one, dependent ones add up", async () => {
    const h = harness();
    const one = await metered(h, async () => {
      await Promise.all([h.admin.from("motorist_call_sessions").select("id"), h.client.rpc("motorist_provider_pending_commands_v2", {})]);
      await h.admin.from("motorist_call_legs").select("id");
    });
    expect(one).toMatchObject({ requests: 3, waves: 2 });
  });

  async function outbound(h: TelephonyHarness) {
    const start = await metered(h, () => startOutboundCall(rateLimited(h), actor, { to: NUMBERS.customer, requestId: requestId(9101) }));
    return { start, call: start.value };
  }

  function nativeWorld() {
    for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
      VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
      APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
    return harness();
  }

  async function colleague(h: TelephonyHarness) {
    const start = await metered(h, () => callColleague(rateLimited(h), actor, { targetProfileId: PROFILES.o2, requestId: requestId(9102) }));
    return { start, call: start.value };
  }

  it("starts an outgoing direct-connect call", async () => {
    const h = harness();
    const { start, call } = await outbound(h);
    expect(call.operatorLegCallControlId).toBeTruthy();
    bounded(start.requests, BOUND.outboundStart.requests);
    bounded(sendWave(start, "dial"), BOUND.outboundStart.toOwnDial);
    bounded(start.waves, BOUND.outboundStart.resolved);
  });

  it.each([1, 2] as const)("starts a colleague call to %i application endpoint(s)", async (endpoints) => {
    const h = endpoints === 2 ? nativeWorld() : harness();
    if (endpoints === 2) h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: PROFILES.o2, environment: "development",
      sip_username: "native-colleague", device_session_id: requestId(9103), device_seen_at: h.now().toISOString(), registration_state: "registered" }]);
    const { start, call } = await colleague(h);
    expect(readMeta(h.session(call.sessionId) as SessionRow).internal?.endpoints?.length ?? 1).toBe(endpoints);
    bounded(start.requests, BOUND.colleagueStart[endpoints].requests);
    bounded(sendWave(start, "dial"), BOUND.colleagueStart[endpoints].toOwnDial);
    bounded(start.waves, BOUND.colleagueStart[endpoints].resolved);

    // The caller's own leg answers: the colleague is dialled.
    h.telnyx.physical.answered(call.operatorLegCallControlId);
    const answer = await metered(h, () => h.legEvent(call.operatorLegCallControlId, "call.answered"));
    const colleagueDial = endpoints === 1 ? sendWave(answer, "dial") : Math.min(sendWave(answer, "dial", 0), sendWave(answer, "dial", 1));
    bounded(colleagueDial, BOUND.internalOwnAnswer[endpoints].toColleagueDial);
    bounded(answer.requests, BOUND.internalOwnAnswer[endpoints].requests);
  });

  it("dials the customer when the operator's own leg answers", async () => {
    const h = harness();
    const { call } = await outbound(h);
    h.telnyx.physical.answered(call.operatorLegCallControlId);
    const answer = await metered(h, () => h.legEvent(call.operatorLegCallControlId, "call.answered"));
    expect(h.session(call.sessionId).state).toBe("ringing");
    bounded(sendWave(answer, "dial"), BOUND.outboundOwnAnswer.toCustomerDial);
    bounded(answer.requests, BOUND.outboundOwnAnswer.requests);
  });

  it("costs little for call.initiated of a leg the dial already recorded", async () => {
    const h = harness();
    const { call } = await outbound(h);
    const initiated = await metered(h, () => h.legEvent(call.operatorLegCallControlId, "call.initiated"));
    expect(initiated.value.outcome).toMatch(/processed|ignored/);
    bounded(initiated.requests, BOUND.knownInitiated.requests);
  });

  it("connects a colleague who answers, then observes call.bridged", async () => {
    const h = harness();
    const { call } = await colleague(h);
    h.telnyx.physical.answered(call.operatorLegCallControlId);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const callee = String(h.openLegFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
    h.telnyx.physical.answered(callee);
    const answer = await metered(h, () => h.legEvent(callee, "call.answered"), meter => {
      meter.watch("talking", () => h.session(call.sessionId).state === "talking");
      meter.watch("callee answered_at", () => Boolean(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === callee)?.answered_at));
    });
    expect(h.session(call.sessionId).state).toBe("talking");
    bounded(sendWave(answer, "bridge"), BOUND.internalCalleeAnswer.toBridge);
    bounded(markWave(answer, "talking"), BOUND.internalCalleeAnswer.toTalking);
    bounded(markWave(answer, "callee answered_at"), BOUND.internalCalleeAnswer.toCalleeAnswered);
    bounded(answer.requests, BOUND.internalCalleeAnswer.requests);

    const first = await metered(h, () => h.legEvent(callee, "call.bridged"));
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === callee)?.bridged_at).toBeTruthy();
    bounded(first.requests, BOUND.firstBridged.requests);
    bounded(first.leases, BOUND.firstBridged.leases);
    const duplicate = await metered(h, () => h.legEvent(callee, "call.bridged"));
    bounded(duplicate.requests, BOUND.duplicateBridged.requests);
    bounded(duplicate.leases, BOUND.duplicateBridged.leases);
  });

  it("holds from the web console, first with the conference promotion and later without", async () => {
    const h = harness();
    const call = await talking(h);
    const first = await metered(h, () => holdCall(h.deps, actor, call.sessionId));
    expect(h.session(call.sessionId).state).toBe("held");
    await unholdCall(h.deps, actor, call.sessionId);
    const later = await metered(h, () => holdCall(h.deps, actor, call.sessionId));
    expect(h.session(call.sessionId).state).toBe("held");
    bounded(first.requests, BOUND.webHoldFirst.requests);
    bounded(first.waves, BOUND.webHoldFirst.waves);
    bounded(later.requests, BOUND.webHoldLater.requests);
    bounded(later.waves, BOUND.webHoldLater.waves);
  });

  it("holds from the phone, first with the conference promotion and later without", async () => {
    const h = nativeWorld();
    const call = await talking(h);
    const control = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
    h.telnyx.physical.answered(control);
    const lease = requestId(9104);
    const web = h.rows("motorist_operator_devices").find(row => row.profile_id === actor.profileId)!;
    h.db.seed("motorist_operator_mobile_devices", [{ ...web, sip_username: "native-hold", device_session_id: lease, registration_state: "registered", metadata: {} }]);
    h.db.update("motorist_call_legs", { to_number: "sip:native-hold@sip.telnyx.com" }, row => row.telnyx_call_control_id === control);
    const mobile = { ...h.deps, deviceKind: "mobile" } as TelephonyRuntimeDeps;
    const phone = { userId: actor.profileId, profileId: actor.profileId, organizationId: ORG, displayName: "Test", role: "dispatcher" as const };
    const body = (n: number, held: boolean) => ({ deviceSessionId: lease, requestId: requestId(n), callControlId: control, held,
      expectedVersion: Number(h.session(call.sessionId).version) });
    const first = await metered(h, () => changeNativeHold(mobile, phone, call.sessionId, body(9105, true)));
    expect(first.value).toMatchObject({ operation: { outcome: "accepted", held: true } });
    await changeNativeHold(mobile, phone, call.sessionId, body(9106, false));
    const later = await metered(h, () => changeNativeHold(mobile, phone, call.sessionId, body(9107, true)));
    expect(later.value).toMatchObject({ operation: { outcome: "accepted", held: true } });
    bounded(first.requests, BOUND.nativeHoldFirst.requests);
    bounded(first.waves, BOUND.nativeHoldFirst.waves);
    bounded(later.requests, BOUND.nativeHoldLater.requests);
    bounded(later.waves, BOUND.nativeHoldLater.waves);
  });
});
