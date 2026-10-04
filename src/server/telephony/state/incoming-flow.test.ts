import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingFlow } from "@/lib/telephony/incoming-flow";
import { createTelephonyHarness, LINES, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { pickupWaitingCall } from "../call-actions";
import { runSessionEvent } from "../session-runner";
import { readMeta, type CallbackPlan, type SessionRow } from "./types";

const ids = [1, 2, 3, 4].map(index => `00000000-0000-4000-8000-00000000800${index}`);
const ring = { id: ids[0], type: "ring" as const, seconds: 20, people: [{ profileId: PROFILES.o1, application: true, personalNumber: null }] };
const wait = { id: ids[1], type: "wait" as const, minutes: 1 };
const flow: IncomingFlow = { version: 1, ending: "hangup", steps: [ring, wait,
  { id: ids[2], type: "repeat", stepIds: [ids[0]], times: 1 },
  { id: ids[3], type: "external", number: NUMBERS.external, seconds: 15 },
] };
const meta = (h: TelephonyHarness, id: string) => readMeta(h.session(id) as SessionRow);
beforeEach(() => vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());
const harness = () => {
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  // Callback RPC boundary; durable callback semantics have their own SQL tests.
  h.db.registerRpc("motorist_create_callback_obligation_v1", args => {
    const plan = args.p_plan as CallbackPlan;
    return h.rows("motorist_callback_requests").find(row => row.session_id === args.p_session_id) ?? h.db.insert("motorist_callback_requests", {
      organization_id: args.p_organization_id, session_id: args.p_session_id, caller_number: plan.callerNumber,
      source: plan.source, status: "open", metadata: plan.request ? { request: plan.request } : {},
    })[0];
  });
  return h;
};
function mobileDevice(h: TelephonyHarness, agoMs = 0) {
  const web = h.rows("motorist_operator_devices").find(row => row.profile_id === PROFILES.o1)!;
  h.db.seed("motorist_operator_mobile_devices", [{ ...web, id: "00000000-0000-4000-8000-000000009101", sip_username: "mobile-app", device_seen_at: new Date(h.now().getTime() - agoMs).toISOString() }]);
}
function configure(h: TelephonyHarness, value: IncomingFlow = flow) {
  h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: value } }, row => row.id === LINES.allianz);
}
async function sweep(h: TelephonyHarness, sessionId: string) {
  return runSessionEvent(h.deps, sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
}
async function waiting() {
  const h = harness();
  configure(h);
  const call = await h.inbound({ to: NUMBERS.allianz });
  expect(h.telnyx.of("dial")).toHaveLength(1);
  const first = h.openLegFor(call.sessionId, PROFILES.o1)!;
  await h.legEvent(String(first.telnyx_call_control_id), "call.hangup", { hangup_cause: "timeout" });
  expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", current_step: 2 });
  expect(meta(h, call.sessionId).waiting).toMatchObject({ max_minutes: 1, flow_step_index: 1 });
  expect(meta(h, call.sessionId).queue).toMatchObject({ manual_only: true });
  return { h, call, first };
}

describe("unified incoming flow execution", () => {
  it("runs ring → bounded wait → same person again → external number → hangup with fresh command identities", async () => {
    const { h, call, first } = await waiting();
    const firstDial = h.telnyx.of("dial")[0];
    const staleGather = h.telnyx.of("gatherUsingAudio").at(-1)!.params.clientState;
    h.advance(30_000);
    await sweep(h, call.sessionId);
    expect(h.telnyx.of("dial")).toHaveLength(1);
    h.advance(30_000);
    h.touchDevice(PROFILES.o1);
    await sweep(h, call.sessionId);
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", current_step: 3 });
    expect(meta(h, call.sessionId)).toMatchObject({ waiting: null, queue: null, gather: null });
    const retry = h.openLegFor(call.sessionId, PROFILES.o1)!;
    expect(retry.telnyx_call_control_id).not.toBe(first.telnyx_call_control_id);
    expect(h.telnyx.of("dial").at(-1)?.params.commandId).not.toBe(firstDial.params.commandId);
    expect(h.attempts(call.sessionId).map(attempt => attempt.step_index)).toEqual([0, 2]);
    const afterRetry = h.telnyx.of("dial").length;
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: staleGather });
    await sweep(h, call.sessionId);
    expect(h.telnyx.of("dial")).toHaveLength(afterRetry);
    await h.legEvent(String(retry.telnyx_call_control_id), "call.hangup", { hangup_cause: "timeout" });
    const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
    expect(backup).toBeTruthy();
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", current_step: 4 });
    await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "timeout" });
    expect(h.session(call.sessionId).state).toBe("missed");
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
    expect(h.rows("motorist_job_incidents")).toEqual([]);
  });

  it("keeps the frozen flow when its line is edited during a wait", async () => {
    const { h, call } = await waiting();
    configure(h, { version: 1, ending: "callback_prompt", steps: [{ ...ring, people: [{ profileId: PROFILES.o2, application: true, personalNumber: null }] }] });
    h.advance(60_000);
    h.touchDevice(PROFILES.o1);
    await sweep(h, call.sessionId);
    expect(h.telnyx.of("dial").at(-1)?.params.to).toBe("sip:gencred001@sip.telnyx.com");
    expect(meta(h, call.sessionId).ring?.plan?.fallback.kind).toBe("hangup");
  });

  it("permits an initial wait and respects it over the legacy inbound mode", async () => {
    const h = harness();
    configure(h, { version: 1, ending: "hangup", steps: [wait, ring] });
    h.db.update("motorist_telephony_lines", { inbound_call_mode: "ring_all" }, row => row.id === LINES.allianz);
    h.db.update("motorist_telephony_settings", { inbound_call_mode: "queue_first" }, () => true);
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", current_step: 1 });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    h.advance(60_000);
    h.touchDevice(PROFILES.o1);
    await sweep(h, call.sessionId);
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", current_step: 2 });
    expect(h.telnyx.of("dial")).toHaveLength(1);
  });

  it("does not continue after the caller hangs up in a wait", async () => {
    const { h, call } = await waiting();
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    h.advance(60_000);
    await sweep(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.telnyx.of("dial")).toHaveLength(1);
  });

  it("a successful manual pickup wins over a later wait timeout", async () => {
    const { h, call } = await waiting();
    await pickupWaitingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId);
    const picker = h.openLegFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(picker.telnyx_call_control_id), "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o2 });
    h.advance(60_000);
    await sweep(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("dial")).toHaveLength(2);
    expect(h.telnyx.of("bridge")).toHaveLength(1);
  });

  it("expires an unanswered pickup and prevents its delayed answer from winning the next step", async () => {
    const { h, call } = await waiting();
    await pickupWaitingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId);
    const picker = h.openLegFor(call.sessionId, PROFILES.o2)!;
    h.advance(60_000);
    h.touchDevice(PROFILES.o1);
    await sweep(h, call.sessionId);
    // A stale pickup reservation may be released first; the next pass must advance.
    await sweep(h, call.sessionId);
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", current_step: 3 });
    await h.legEvent(String(picker.telnyx_call_control_id), "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", answered_by_profile_id: null });
    expect(h.telnyx.of("bridge")).toHaveLength(0);
  });

  it("does not dial a stale mobile app or exceed the per-call capacity with extra app endpoints", async () => {
    const h = harness();
    mobileDevice(h, 200_000);
    configure(h, { version: 1, ending: "hangup", steps: [ring] });
    await h.inbound({ to: NUMBERS.allianz });
    expect(h.telnyx.of("dial").map(dial => dial.params.to)).toEqual(["sip:gencred001@sip.telnyx.com"]);
    const capped = harness();
    mobileDevice(capped);
    configure(capped, { version: 1, ending: "hangup", steps: [ring] });
    capped.db.update("motorist_telephony_settings", { max_concurrent_legs: 2 }, () => true);
    await capped.inbound({ to: NUMBERS.allianz });
    expect(capped.telnyx.of("dial")).toHaveLength(1);
    expect(capped.telnyx.of("dial")[0].params.to).toBe("sip:gencred001@sip.telnyx.com");
  });

  it("advances a fifteen-minute wait with bounded existing gather ticks, without a long provider timer", async () => {
    const h = harness();
    configure(h, { version: 1, ending: "hangup", steps: [{ ...wait, minutes: 15 }, ring] });
    const call = await h.inbound({ to: NUMBERS.allianz });
    for (let minute = 1; minute <= 15; minute++) {
      const gather = h.telnyx.calls.filter(command => ["gather", "gatherUsingAudio", "gatherUsingSpeak"].includes(command.method)).at(-1)!;
      expect(Number(gather.params.timeoutMillis)).toBeLessThanOrEqual(60_000);
      h.advance(60_000);
      h.touchDevice(PROFILES.o1);
      await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: gather.params.clientState });
      if (minute < 15) expect(h.session(call.sessionId).state).toBe("waiting");
    }
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", current_step: 2 });
    expect(h.telnyx.of("dial")).toHaveLength(1);
  });
});
