import { afterEach, describe, expect, it, vi } from "vitest";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { cancelConsult, holdCall, startConsult, unholdCall } from "../call-actions";
import { recoverSessionContactChecks } from "../session-runner";
import { SessionLeaseBusyError, SessionLeaseLostError } from "../service-errors";
import { runPendingEffectRecovery } from "../cron-jobs";
import { readPendingEffects } from "./continuation";
import { readMeta, type SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

function harness(writerContract: 1 | 2 = 2) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  for (const key of ["TELNYX_RECORDING_ENABLED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED",
    "TELNYX_RECORDING_CHANNELS_VERIFIED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED"]) vi.stubEnv(key, "true");
  const h = createTelephonyHarness({ ...(writerContract === 2 ? { writerContract } : {}), sweepAfterEvent: false });
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true,
    approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  return h;
}

async function ringing(h: TelephonyHarness) {
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  return { ...call, operator };
}

async function talking(h: TelephonyHarness) {
  const call = await ringing(h);
  expect((await h.legEvent(call.operator, "call.answered")).outcome).toBe("processed");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  return call;
}

describe.each([1, 2] as const)("recording critical path, writer contract %s", writerContract => {
  it.each(["motorist_calls", "motorist_ring_group_members"])("connects recorded audio despite a persistent %s projection failure", async table => {
    const h = harness(writerContract), call = await ringing(h);
    const original = h.db.takeInjectedError.bind(h.db);
    const fault = vi.spyOn(h.db, "takeInjectedError").mockImplementation((name, operation) => {
      if (name === table && operation === "update") {
        expect(h.telnyx.physical.connected(call.callControlId, call.operator)).toBe(true);
        return { code: "08006", message: "history unavailable", details: null, hint: null };
      }
      return original(name, operation);
    });
    const result = await h.legEvent(call.operator, "call.answered");
    expect(result.error ?? result.outcome).toBe("processed");
    const session = h.session(call.sessionId) as SessionRow;
    expect(h.telnyx.physical.connected(call.callControlId, call.operator)).toBe(true);
    expect(readMeta(session).recording).toMatchObject({ pendingAudio: null, recorders: [expect.objectContaining({ observed: "recording", providerRecordingId: expect.any(String) })] });
    expect(readPendingEffects(session).entries[0].lastError).toContain("history unavailable");
    fault.mockRestore();
    h.advance(5 * 60_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(h.telnyx.of("conference:join")).toHaveLength(1);
    expect(h.call(call.sessionId)).toMatchObject({ status: "answered", operator_id: PROFILES.o1 });
  });

  it("creates a missing call identity before recording admission without restoring stale recorder state", async () => {
    const h = harness(writerContract), call = await ringing(h);
    h.db.delete("motorist_calls", row => row.session_id === call.sessionId);
    const start = h.telnyx.client.recordingStart.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "recordingStart").mockImplementation(async params => {
      expect(h.call(call.sessionId)?.id).toBeTruthy();
      return start(params);
    });
    expect((await h.legEvent(call.operator, "call.answered")).outcome).toBe("processed");
    const recording = readMeta(h.session(call.sessionId) as SessionRow).recording!;
    expect(recording.recorders[0].observed).toBe("recording");
    expect(recording.recorders[0].providerRecordingId).toBeTruthy();
    expect(recording.pendingAudio).toBeNull();
    expect(recording.connection?.conferenceId).toBe(h.session(call.sessionId).conference_id);
  });

  it("holds after confirmed STOP and resumes without waiting for optional control speech", async () => {
    const h = harness(writerContract), call = await talking(h);
    h.telnyx.calls.length = 0;
    await holdCall(h.deps, actor, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("held");
    expect(h.telnyx.calls.map(row => row.method).indexOf("recordingStop")).toBeLessThan(h.telnyx.calls.map(row => row.method).indexOf("conference:hold"));
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    await unholdCall(h.deps, actor, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.pendingAudio).toBeNull();
  });

  it("opens participant evidence after connection rather than during recorder warmup", async () => {
    const h = harness(writerContract), call = await ringing(h);
    const create = h.telnyx.client.createConference.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async params => {
      expect(h.rows("motorist_call_participant_intervals")).toEqual([]);
      return create(params);
    });
    await h.legEvent(call.operator, "call.answered");
    expect(h.rows("motorist_call_participant_intervals").filter(row => !row.ended_at)).toEqual([
      expect.objectContaining({ role: "customer", verified: true }),
      expect.objectContaining({ role: "operator", verified: true, profile_id: actor.profileId }),
    ]);
  });

  if (writerContract === 2) {
    it("returns from cancelled consultation with resumed recording before a slow contact verification", async () => {
      const h = harness(writerContract), call = await talking(h);
      await startConsult(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 });
      const consult = h.legs(call.sessionId).find(leg => leg.role === "consult")!;
      h.telnyx.physical.answered(String(consult.telnyx_call_control_id));
      await h.legEvent(String(consult.telnyx_call_control_id), "call.answered");
      const request = h.telnyx.client.request.bind(h.telnyx.client);
      let checks = 0;
      const slow = vi.spyOn(h.telnyx.client, "request").mockImplementation(async (method, path, options) => {
        if (path.endsWith("/participants") && options?.query?.["page[size]"] === 250) {
          checks += 1;
          throw new SessionLeaseLostError();
        }
        return request(method, path, options);
      });
      h.telnyx.calls.length = 0;

      await cancelConsult(h.deps, actor, call.sessionId);

      expect(checks).toBe(0);
      expect(h.session(call.sessionId).state).toBe("talking");
      expect(h.telnyx.physical.connected(call.callControlId, call.operator)).toBe(true);
      expect(readMeta(h.session(call.sessionId) as SessionRow).recording).toMatchObject({ pendingAudio: null,
        recorders: expect.arrayContaining([expect.objectContaining({ observed: "recording" })]) });
      expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.some(entry => entry.transition.contactChecks?.length)).toBe(true);
      const sent = h.telnyx.calls.length;
      slow.mockRestore();
      await recoverSessionContactChecks(h.deps, call.sessionId);
      expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
      expect(h.telnyx.calls.slice(sent).every(row => row.method === "request")).toBe(true);
    });

    it("does not dispatch a pending privacy STOP from optional contact recovery", async () => {
      const h = harness(writerContract), call = await talking(h);
      await holdCall(h.deps, actor, call.sessionId);
      await unholdCall(h.deps, actor, call.sessionId);
      expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.some(entry => entry.transition.contactChecks?.length)).toBe(true);
      h.telnyx.failAlways("recordingStop", "timeout");
      await expect(holdCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 502 });
      h.telnyx.clearFailures();
      const sent = h.telnyx.calls.length;

      await recoverSessionContactChecks(h.deps, call.sessionId);

      expect(h.telnyx.calls.slice(sent).every(row => row.method === "request")).toBe(true);
      expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.some(entry => entry.commands.some(command => command.kind === "recording_stop"))).toBe(true);
    });

    it("yields optional contact recovery immediately to a busy call", async () => {
      const h = harness(writerContract), call = await talking(h);
      await holdCall(h.deps, actor, call.sessionId);
      await unholdCall(h.deps, actor, call.sessionId);
      const before = readPendingEffects(h.session(call.sessionId) as SessionRow);
      h.db.registerRpc("motorist_session_lease_acquire_v2", () => null);
      const sent = h.telnyx.calls.length;
      const polls = h.db.log.filter(row => row.table === "motorist_session_lease_acquire_v2").length;

      await expect(recoverSessionContactChecks(h.deps, call.sessionId)).rejects.toBeInstanceOf(SessionLeaseBusyError);

      expect(h.db.log.filter(row => row.table === "motorist_session_lease_acquire_v2")).toHaveLength(polls + 1);
      expect(h.telnyx.calls).toHaveLength(sent);
      expect(readPendingEffects(h.session(call.sessionId) as SessionRow)).toEqual(before);
    });
  }

  it("lets a new hold bypass completed audio whose historical projection is still unavailable", async () => {
    const h = harness(writerContract), call = await ringing(h);
    const original = h.db.takeInjectedError.bind(h.db);
    vi.spyOn(h.db, "takeInjectedError").mockImplementation((name, operation) =>
      name === "motorist_calls" && operation === "update" ? { code: "08006", message: "history unavailable", details: null, hint: null } : original(name, operation));
    await h.legEvent(call.operator, "call.answered");
    await holdCall(h.deps, actor, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("held");
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.recorders[0].observed).toBe("stopped");
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.length).toBeGreaterThan(0);
  });

  it("still refuses private consultation after an unconfirmed STOP with optional prompts disabled", async () => {
    const h = harness(writerContract), call = await talking(h);
    h.telnyx.calls.length = 0;
    h.telnyx.failAlways("recordingStop", "timeout");
    await expect(startConsult(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 })).rejects.toMatchObject({ status: 502 });
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    expect(h.telnyx.physical.connected(call.callControlId, call.operator)).toBe(true);
  });

  it("retains operational prompts when explicitly enabled", async () => {
    const h = harness(writerContract), call = await talking(h);
    vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "true");
    h.telnyx.calls.length = 0;
    await holdCall(h.deps, actor, call.sessionId);
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence?.keys).toEqual(["holdStart"]);
    expect(new Set(h.telnyx.of("recordingStop").map(row => row.params.commandId)).size).toBe(1);
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("held");
  });
});
