import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingFlow } from "@/lib/telephony/incoming-flow";
import { journeyElapsedSeconds } from "@/lib/telephony/call-journey";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { loadActiveCallJourneys, loadCallJourney } from "./call-journey";
import { runSessionEvent } from "./session-runner";
import { pickupWaitingCall } from "./call-actions";
import { readMeta, type CallbackPlan, type SessionRow } from "./state/types";

const ids = [1, 2, 3].map(index => `00000000-0000-4000-8000-00000000930${index}`);
const flow: IncomingFlow = { version: 1, ending: "callback_prompt", steps: [
  { id: ids[0], type: "ring", seconds: 20, people: [{ profileId: PROFILES.o1, application: true, personalNumber: null }] },
  { id: ids[1], type: "wait", minutes: 1, policy: { mode: "callback", intervalSeconds: 15 } },
  { id: ids[2], type: "repeat", stepIds: [ids[0]], times: 1 },
] };
beforeEach(() => {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network forbidden in call journey integration QA"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function setup() {
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: flow } }, row => row.id === LINES.allianz);
  // The obligation SQL is tested separately; keep the same persisted proof
  // shape while driving the real event runner and read service here.
  h.db.registerRpc("motorist_create_callback_obligation_v1", args => {
    const plan = args.p_plan as CallbackPlan;
    return h.rows("motorist_callback_requests").find(row => row.session_id === args.p_session_id) ?? h.db.insert("motorist_callback_requests", {
      organization_id: args.p_organization_id, session_id: args.p_session_id, caller_number: plan.callerNumber,
      source: plan.source, status: "open", metadata: plan.request ? { request: plan.request } : {},
    })[0];
  });
  return h;
}
const readDeps = (h: TelephonyHarness) => ({ admin: h.admin, organizationId: ORG, now: h.now });
const read = (h: TelephonyHarness, sessionId: string) => loadCallJourney(readDeps(h), sessionId, "session");
const sweep = (h: TelephonyHarness, sessionId: string) => runSessionEvent(h.deps, sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
const lastGather = (h: TelephonyHarness) => h.telnyx.calls.filter(command => ["gather", "gatherUsingAudio", "gatherUsingSpeak"].includes(command.method)).at(-1)!;
async function endFirstOffer(h: TelephonyHarness, sessionId: string) {
  const first = h.openLegFor(sessionId, PROFILES.o1)!;
  await h.legEvent(String(first.telnyx_call_control_id), "call.hangup", { hangup_cause: "timeout" });
}

describe("persisted journey through complete contract-two calls", () => {
  it("persists ring20 → wait60 → repeated ring7 → answer and reads the same history after hangup", async () => {
    const h = setup(), call = await h.inbound({ to: NUMBERS.allianz });
    const initial = await read(h, call.sessionId);
    expect(initial.currentOccurrenceId).toBe(`${call.sessionId}:0`);
    h.advance(20_000); await endFirstOffer(h, call.sessionId);
    const waiting = await read(h, call.sessionId);
    expect(waiting.currentOccurrenceId).toBe(`${call.sessionId}:1`);
    expect(journeyElapsedSeconds(waiting.occurrences[0].startedAt, waiting.occurrences[0].endedAt, h.now().getTime())).toBe(20);
    h.advance(60_000); h.touchDevice(PROFILES.o1); await sweep(h, call.sessionId);
    const repeated = await read(h, call.sessionId);
    expect(repeated.currentOccurrenceId).toBe(`${call.sessionId}:2`);
    expect(repeated.occurrences[2]).toMatchObject({ sourceStepId: ids[0], repeatStepId: ids[2], repeatRound: 1 });
    expect(journeyElapsedSeconds(repeated.occurrences[1].startedAt, repeated.occurrences[1].endedAt, h.now().getTime())).toBe(60);
    h.advance(7_000);
    const operator = h.openLegFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(operator.telnyx_call_control_id), "call.answered");
    const answered = await read(h, call.sessionId);
    expect(answered.currentOccurrenceId).toBeNull();
    expect(answered.occurrences.slice(0, 3).map(step => step.state)).toEqual(["completed", "completed", "completed"]);
    expect(journeyElapsedSeconds(answered.occurrences[2].startedAt, answered.occurrences[2].endedAt, h.now().getTime())).toBe(7);
    expect(answered.occurrences[2].endpoints[0]).toMatchObject({ profileId: PROFILES.o1, channel: "web", state: "answered" });
    h.advance(40_000);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    const history = await loadCallJourney(readDeps(h), String(h.call(call.sessionId)!.id));
    expect(history).toMatchObject({ customerActive: false, phase: "ended" });
    expect(history.occurrences.slice(0, 3).map(step => journeyElapsedSeconds(step.startedAt, step.endedAt, h.now().getTime()))).toEqual([20, 60, 7]);
    expect(history.occurrences.at(-1)?.state).toBe("not_reached");
    const persisted = readMeta(h.session(call.sessionId) as SessionRow).journey!;
    expect(persisted.entries.filter(entry => entry.kind === "step_enter").map(entry => entry.stepIndex)).toEqual([0, 1, 2]);
    expect(h.db.log.some(entry => entry.kind === "rpc" && entry.table === "motorist_apply_critical_v2")).toBe(true);
    expect(h.rows("motorist_job_incidents")).toEqual([]);
  });

  it("stores a DTMF request during the wait once, never reaches the later ring or final fallback", async () => {
    const h = setup(), call = await h.inbound({ to: NUMBERS.allianz });
    h.advance(20_000); await endFirstOffer(h, call.sessionId);
    h.advance(11_000);
    const eventId = h.nextEventId(), state = lastGather(h).params.clientState;
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "valid", digits: "1", client_state: state }, eventId);
    const confirmed = await read(h, call.sessionId);
    expect(confirmed).toMatchObject({ phase: "callback_confirmation", currentOccurrenceId: null, callback: { kind: "requested", digit: "1", requestedAt: h.now().toISOString() } });
    expect(confirmed.occurrences[1]).toMatchObject({ state: "completed", reason: "callback_requested" });
    expect(journeyElapsedSeconds(confirmed.occurrences[1].startedAt, confirmed.occurrences[1].endedAt, h.now().getTime())).toBe(11);
    expect(confirmed.occurrences.slice(2).map(step => step.state)).toEqual(["not_reached", "not_reached"]);
    const beforeReplay = readMeta(h.session(call.sessionId) as SessionRow).journey!.entries;
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "valid", digits: "1", client_state: state }, eventId);
    expect(readMeta(h.session(call.sessionId) as SessionRow).journey!.entries).toEqual(beforeReplay);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    const lastAudio = h.telnyx.of("playbackStart").at(-1)!;
    h.advance(4_000);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: lastAudio.params.clientState });
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    const history = await read(h, call.sessionId);
    expect(history.callback?.kind).toBe("requested");
    expect(history.events.filter(event => event.kind === "callback_requested")).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(1);
  });

  it("keeps two same-number calls on separate steps and clocks through fresh database reads", async () => {
    const h = setup(), first = await h.inbound({ to: NUMBERS.allianz });
    h.advance(3_000);
    const second = await h.inbound({ to: NUMBERS.allianz });
    h.advance(7_000);
    const active = await loadActiveCallJourneys(readDeps(h), LINES.allianz);
    expect(active.calls).toHaveLength(2);
    const a = active.calls.find(call => call.sessionId === first.sessionId)!, b = active.calls.find(call => call.sessionId === second.sessionId)!;
    expect(a.callerNumber).toBe(b.callerNumber);
    expect(a.currentOccurrenceId).toBe(`${first.sessionId}:0`);
    expect(b.currentOccurrenceId).toBe(`${second.sessionId}:1`);
    expect(journeyElapsedSeconds(a.occurrences[0].startedAt, null, h.now().getTime())).toBe(10);
    expect(journeyElapsedSeconds(b.occurrences[1].startedAt, null, h.now().getTime())).toBe(7);
    expect(b.occurrences[0].state).toBe("skipped");
    h.advance(10_000); await endFirstOffer(h, first.sessionId);
    h.advance(43_000); h.touchDevice(PROFILES.o1); await sweep(h, second.sessionId);
    const later = await loadActiveCallJourneys(readDeps(h), LINES.allianz);
    expect(later.calls.find(call => call.sessionId === first.sessionId)?.currentOccurrenceId).toBe(`${first.sessionId}:1`);
    expect(later.calls.find(call => call.sessionId === second.sessionId)?.currentOccurrenceId).toBe(`${second.sessionId}:2`);
  });

  it("correlates manual pickup from the persisted leg when no ring attempt exists", async () => {
    const h = setup(), call = await h.inbound({ to: NUMBERS.allianz });
    h.advance(20_000); await endFirstOffer(h, call.sessionId);
    h.advance(9_000);
    await pickupWaitingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId);
    const picker = h.openLegFor(call.sessionId, PROFILES.o2)!;
    h.advance(2_000); await h.legEvent(String(picker.telnyx_call_control_id), "call.answered");
    const data = await read(h, call.sessionId);
    expect(data.occurrences[1].endpoints).toEqual([expect.objectContaining({ profileId: PROFILES.o2, state: "answered", reason: "manual_pickup", displayName: "Peter Dispečer" })]);
    expect(journeyElapsedSeconds(data.occurrences[1].startedAt, data.occurrences[1].endedAt, h.now().getTime())).toBe(11);
    expect(h.attempts(call.sessionId).some(attempt => attempt.profile_id === PROFILES.o2)).toBe(false);
  });

  it("retains a manual pickup that auto-answers in the same timestamp tick", async () => {
    const h = setup(), call = await h.inbound({ to: NUMBERS.allianz });
    h.advance(20_000); await endFirstOffer(h, call.sessionId);
    h.advance(9_000);
    await pickupWaitingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId);
    const picker = h.openLegFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(picker.telnyx_call_control_id), "call.answered");
    const data = await read(h, call.sessionId);
    expect(data.occurrences[1].endpoints).toEqual([expect.objectContaining({ profileId: PROFILES.o2, state: "answered", reason: "manual_pickup" })]);
  });

  it("does not move a same-timestamp pickup from the next ring back into the expired wait", async () => {
    const h = setup(), call = await h.inbound({ to: NUMBERS.allianz });
    h.advance(20_000); await endFirstOffer(h, call.sessionId);
    h.advance(60_000); h.touchDevice(PROFILES.o1); await sweep(h, call.sessionId);
    await pickupWaitingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId);
    const picker = h.openLegFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(picker.telnyx_call_control_id), "call.answered");
    const data = await read(h, call.sessionId);
    expect(data.occurrences[1].reason).toBe("wait_timeout");
    expect(data.occurrences[1].endpoints).toEqual([]);
    expect(data.occurrences[2].endpoints).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: PROFILES.o2, state: "answered", reason: "manual_pickup" })]));
  });

  it("projects real persisted web/mobile/PSTN sibling offers and their single mobile winner", async () => {
    const h = setup(), combined = structuredClone(flow);
    if (combined.steps[0].type !== "ring") throw new Error("fixture");
    combined.steps[0].people[0].personalNumber = NUMBERS.external;
    h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: combined } }, row => row.id === LINES.allianz);
    const device = h.rows("motorist_operator_devices").find(row => row.profile_id === PROFILES.o1)!;
    h.db.seed("motorist_operator_mobile_devices", [{ ...device, id: "00000000-0000-4000-8000-000000009401", sip_username: "journey-mobile", device_seen_at: h.now().toISOString() }]);
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.telnyx.of("dial")).toHaveLength(3);
    const before = await read(h, call.sessionId);
    expect(before.occurrences[0].endpoints.map(endpoint => endpoint.channel).sort()).toEqual(["mobile_app", "personal_number", "web"]);
    h.advance(5_000);
    const mobile = h.legs(call.sessionId).find(leg => (leg.client_state as { applicationDevice?: string })?.applicationDevice === "mobile")!;
    await h.legEvent(String(mobile.telnyx_call_control_id), "call.answered");
    const after = await read(h, call.sessionId);
    expect(after.occurrences[0].endpoints.filter(endpoint => endpoint.state === "answered")).toEqual([expect.objectContaining({ channel: "mobile_app" })]);
    expect(after.occurrences[0].endpoints.filter(endpoint => endpoint.state === "cancelled").map(endpoint => endpoint.reason)).toEqual(["answered_elsewhere", "answered_elsewhere"]);
    expect(after.occurrences[0].endpoints.map(endpoint => journeyElapsedSeconds(endpoint.offeredAt, endpoint.answeredAt ?? endpoint.endedAt, h.now().getTime()))).toEqual([5, 5, 5]);
    expect(after.currentOccurrenceId).toBeNull();
  });

  it("keeps final audio visible in the active line read until the real customer hangup event", async () => {
    const h = setup();
    h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: { ...flow, steps: [flow.steps[0]], ending: "hangup_message" } } }, row => row.id === LINES.allianz);
    const call = await h.inbound({ to: NUMBERS.allianz });
    h.advance(20_000); await endFirstOffer(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("missed");
    const live = await loadActiveCallJourneys(readDeps(h), LINES.allianz);
    expect(live.calls.find(item => item.sessionId === call.sessionId)).toMatchObject({ customerActive: true, currentOccurrenceId: `${call.sessionId}:ending` });
    h.advance(6_000);
    const audio = h.telnyx.of("playbackStart").at(-1)!;
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: audio.params.clientState });
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect((await loadActiveCallJourneys(readDeps(h), LINES.allianz)).calls).toEqual([]);
    const history = await read(h, call.sessionId);
    expect(history.occurrences.at(-1)?.state).toBe("completed");
    expect(journeyElapsedSeconds(history.occurrences.at(-1)!.startedAt, history.occurrences.at(-1)!.endedAt, h.now().getTime())).toBe(6);
  });
});
