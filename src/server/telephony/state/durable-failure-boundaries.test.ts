import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { fakeError } from "@/test/fake-supabase";
import { hangupCall, pickupWaitingCall, stopCallRecording } from "../call-actions";
import { runPendingEffectRecovery } from "../cron-jobs";
import { setPresence } from "../presence-service";
import { effectsDeps } from "../session-runner";
import { TelnyxCommandError } from "../telnyx/client";
import { readPendingEffects, stageEffects } from "./continuation";
import { resumePendingEffects } from "./effects";
import { emptyTransition, type Command, type SessionRow, type Transition } from "./types";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const reasonId = "00000000-0000-4000-8000-000000002501";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const session = (h: TelephonyHarness, id: string) => h.session(id) as SessionRow;

async function stage(h: TelephonyHarness, id: string, eventId: string, transition = emptyTransition(), commands: Command[] = []) {
  const current = session(h, id);
  return stageEffects(effectsDeps(h.deps), { session: current, expectedVersion: current.version,
    event: { kind: "app", type: "sweep", id: eventId, actorProfileId: null, occurredAt: h.now().toISOString() },
    result: { next: transition, commands, compensations: [], guard: null, ignored: null } });
}

function historicalCallback(): Transition {
  const transition = emptyTransition();
  transition.callbacks.push({ source: "missed", callerNumber: NUMBERS.customer, createTask: false });
  return transition;
}

async function talking(recording = false) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  if (recording) for (const name of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(name, "true");
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  if (recording) h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  const call = await h.inbound({ to: NUMBERS.allianz });
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  await h.legEvent(operator, "call.answered");
  expect(h.session(call.sessionId).state).toBe("talking");
  expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
  if (recording) expect(h.telnyx.of("recordingStart")).toHaveLength(1);
  return { h, call, operator };
}

describe("durable recovery failure boundaries", () => {
  it("persistent 422 pickup rejection executes one durable compensation without recursive dial", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
    await setPresence(h.deps, { organizationId: ORG, profileId: actor.profileId, status: "paused", pauseReasonId: reasonId });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const before = h.telnyx.of("dial").length;
    h.telnyx.failAlways("dial", new TelnyxCommandError({ code: "invalid_destination", status: 422, detail: "permanent rejection" }));
    await expect(pickupWaitingCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 502 });
    expect(h.telnyx.of("dial")).toHaveLength(before + 1);
    expect(h.presence(actor.profileId)).toMatchObject({ status: "paused", pause_reason_id: reasonId, current_session_id: null });
    expect(h.session(call.sessionId)).toMatchObject({ presence_pickup: null, metadata: { pickup: null } });
    expect(readPendingEffects(session(h, call.sessionId)).entries).toEqual([]);
    h.advance(5 * 60_000);
    await runPendingEffectRecovery(h.deps);
    expect(h.telnyx.of("dial")).toHaveLength(before + 1);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
  });

  it.each([
    { action: "hangup", failure: "callback" }, { action: "recording_stop", failure: "callback" },
    { action: "hangup", failure: "projection" }, { action: "recording_stop", failure: "projection" },
  ] as const)("persistent $failure failure cannot block physical $action", async ({ action, failure }) => {
    const { h, call, operator } = await talking(action === "recording_stop");
    let attempts = 0;
    if (failure === "callback") {
      h.db.registerRpc("motorist_create_callback_obligation_v1", () => { attempts += 1; throw fakeError("persistent callback transaction failure", "08006"); });
    } else {
      const original = h.db.takeInjectedError.bind(h.db);
      vi.spyOn(h.db, "takeInjectedError").mockImplementation((table, operation) => {
        if (table === "motorist_calls" && operation === "update") { attempts += 1; return fakeError("persistent call projection failure", "08006"); }
        return original(table, operation);
      });
    }
    await stage(h, call.sessionId, "older-bookkeeping", failure === "callback" ? historicalCallback() : emptyTransition());
    const stopsBefore = h.telnyx.of("recordingStop").length;
    await Promise.allSettled([action === "hangup" ? hangupCall(h.deps, actor, call.sessionId) : stopCallRecording(h.deps, actor, call.sessionId)]);
    expect(attempts).toBeGreaterThan(0);
    // The action may report that bookkeeping remains unavailable, but the
    // provider must already have executed the committed teardown decision.
    if (action === "hangup") {
      expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
      expect(h.telnyx.physical.legs.get(operator)?.ended).toBe(true);
    } else expect(h.telnyx.of("recordingStop").length).toBeGreaterThan(stopsBefore);
    expect(readPendingEffects(session(h, call.sessionId)).entries.some(entry => entry.id === "older-bookkeeping")).toBe(true);
    if (failure === "callback") expect(h.db.log.filter(entry => entry.kind === "rpc" && entry.table === "motorist_create_callback_obligation_v1").length).toBeGreaterThan(0);
  });

  it("a retry of a failed old conference leave cannot remove its member from a newer conference", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const [row] = h.db.insert("motorist_call_sessions", { organization_id: ORG, state: "talking", line_id: LINES.allianz, caller_number: NUMBERS.customer, called_number: NUMBERS.allianz });
    const id = String(row.id);
    const member = "shared-member", oldPeer = "old-peer", newPeer = "new-peer";
    for (const cc of [member, oldPeer, newPeer]) h.telnyx.physical.answered(cc);
    const old = await h.telnyx.client.createConference({ callControlId: oldPeer, name: "old-conference", commandId: "old-create" });
    await h.telnyx.client.conferenceAction(old.id, "join", { call_control_id: member, commandId: "old-join" });
    h.db.update("motorist_call_sessions", { conference_id: old.id }, item => item.id === id);
    await stage(h, id, "old-leave", emptyTransition(), [{ kind: "conference_leave", commandId: "leave-old", leg: { callControlId: member } }]);
    h.telnyx.failAlways("conference:leave", new TelnyxCommandError({ code: "provider_unavailable", status: 503 }));
    expect((await resumePendingEffects(effectsDeps(h.deps), session(h, id)))?.failed).toBe(true);
    const newer = await h.telnyx.client.createConference({ callControlId: newPeer, name: "new-conference", commandId: "new-create" });
    await h.telnyx.client.conferenceAction(newer.id, "join", { call_control_id: member, commandId: "new-join" });
    const changed = emptyTransition(); changed.session.conference_id = newer.id;
    await stage(h, id, "new-topology", changed);
    h.telnyx.clearFailures();
    await resumePendingEffects(effectsDeps(h.deps), session(h, id));
    expect(h.telnyx.of("conference:leave").every(command => command.params.conferenceId === old.id)).toBe(true);
    expect(h.telnyx.physical.connected(member, newPeer)).toBe(true);
    expect(h.telnyx.physical.connected(member, oldPeer)).toBe(false);
  });

  it("twenty persistently failing historical sessions do not starve the next due session", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const poison = new Set<string>();
    const visited: string[] = [];
    h.db.registerRpc("motorist_create_callback_obligation_v1", args => {
      const id = String(args.p_session_id); visited.push(id);
      if (poison.has(id)) throw fakeError("persistent historical callback failure", "08006");
      return h.db.insert("motorist_callback_requests", { organization_id: ORG, session_id: id, caller_number: NUMBERS.customer, status: "open" })[0];
    });
    const ids: string[] = [];
    for (let index = 0; index < 21; index++) {
      const [row] = h.db.insert("motorist_call_sessions", { organization_id: ORG, state: "ended", direction: "inbound", line_id: LINES.allianz,
        caller_number: NUMBERS.customer, called_number: NUMBERS.allianz, ended_at: h.now().toISOString() });
      const id = String(row.id); ids.push(id);
      if (index < 20) poison.add(id);
      await stage(h, id, `historical-${index}`, historicalCallback());
      h.db.update("motorist_call_sessions", { effects_next_attempt_at: new Date(h.now().getTime() - 60_000 + index).toISOString() }, item => item.id === id);
    }
    expect(await runPendingEffectRecovery(h.deps)).toMatchObject({ status: "failed", detail: { checked: 20 } });
    expect(visited).toHaveLength(20);
    for (const id of poison) expect(Date.parse(String(h.session(id).effects_next_attempt_at))).toBeGreaterThan(h.now().getTime());
    const recovered = await runPendingEffectRecovery(h.deps);
    expect(recovered.detail.errors).toEqual([]);
    expect(recovered).toMatchObject({ status: "ok", detail: { checked: 1 } });
    expect(visited.at(-1)).toBe(ids[20]);
    expect(readPendingEffects(session(h, ids[20])).entries).toEqual([]);
    expect(h.rows("motorist_callback_requests").filter(row => row.session_id === ids[20])).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });
});
