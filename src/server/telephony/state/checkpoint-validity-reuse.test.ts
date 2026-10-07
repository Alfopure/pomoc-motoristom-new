import { afterEach, describe, expect, it, vi } from "vitest";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import type { FakeRow } from "@/test/fake-supabase";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { holdCall, unholdCall } from "../call-actions";
import { readPendingEffects } from "./continuation";
import { commandKey, readMeta, toJson, type SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

async function heldCall(contract: 1 | 2 = 2) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  for (const key of ["TELNYX_RECORDING_ENABLED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED",
    "TELNYX_RECORDING_CHANNELS_VERIFIED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED"]) vi.stubEnv(key, "true");
  const h = createTelephonyHarness({ ...(contract === 2 ? { writerContract: 2 } : {}), sweepAfterEvent: false });
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true,
    approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  await holdCall(h.deps, actor, call.sessionId);
  expect(h.session(call.sessionId).state).toBe("held");
  h.telnyx.calls.length = 0;
  return { h, call };
}

/** The durable boundary after START and its settle, before pending UNHOLD. */
function isStartCheckpoint(values: FakeRow): boolean {
  if (!values.pending_effects || values.metadata) return false;
  return readPendingEffects({ pending_effects: values.pending_effects as SessionRow["pending_effects"] }).entries.some(entry =>
    entry.commands.some(command => command.kind === "recording_start" && entry.completedCommands.includes(commandKey(command))) &&
    entry.commands.some(command => command.kind === "conference_unhold" && !entry.completedCommands.includes(commandKey(command))));
}

describe("single-use validity from a completed command checkpoint", () => {
  it.each([1, 2] as const)("keeps the next privacy validation current for writer contract %s", async contract => {
    const { h, call } = await heldCall(contract);
    const update = h.db.update.bind(h.db);
    let afterCheckpoint = -1;
    vi.spyOn(h.db, "update").mockImplementation((table, values, filter) => {
      const rows = update(table, values, filter);
      if (table === "motorist_call_sessions" && isStartCheckpoint(values) && afterCheckpoint < 0) afterCheckpoint = h.db.log.length;
      return rows;
    });
    const conferenceAction = h.telnyx.client.conferenceAction.bind(h.telnyx.client);
    let validationReads: number | null = null;
    vi.spyOn(h.telnyx.client, "conferenceAction").mockImplementation(async (...args) => {
      if (args[1] === "unhold") {
        expect(afterCheckpoint).toBeGreaterThanOrEqual(0);
        validationReads = h.db.log.slice(afterCheckpoint).filter(entry => entry.table === "motorist_call_sessions" && entry.operation === "select").length;
      }
      return conferenceAction(...args);
    });

    await unholdCall(h.deps, actor, call.sessionId);

    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    expect(h.telnyx.of("conference:unhold")).toHaveLength(1);
    if (contract === 2) expect(validationReads).toBe(0);
    else expect(validationReads).toBeGreaterThan(0);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.pendingAudio).toBeNull();
  });

  it.each(["epoch", "objection", "owner", "termination"] as const)("adopts %s returned by the checkpoint before permitting audio", async reason => {
    const { h, call } = await heldCall();
    const update = h.db.update.bind(h.db);
    let injected = false;
    vi.spyOn(h.db, "update").mockImplementation((table, values, filter) => {
      if (!injected && table === "motorist_call_sessions" && isStartCheckpoint(values)) {
        injected = true;
        const current = h.session(call.sessionId) as SessionRow;
        const meta = readMeta(current), recording = meta.recording!;
        // The checkpoint must expose current metadata in RETURNING, rather
        // than reuse the earlier START acknowledgement/settle snapshot.
        update(table, {
          ...(reason === "owner" ? { answered_by_profile_id: PROFILES.o2 } : {}),
          ...(reason === "termination" ? { termination_requested_at: h.now().toISOString() } : {}),
          metadata: toJson({ ...meta, recording: { ...recording,
            ...(reason === "epoch" ? { epoch: recording.epoch + 1 } : {}),
            ...(reason === "objection" ? { suppressionReason: "objection" } : {}) } }),
        }, row => row.id === call.sessionId);
      }
      return update(table, values, filter);
    });

    const action = unholdCall(h.deps, actor, call.sessionId);
    if (reason === "termination") await expect(action).resolves.toMatchObject({ ignored: null });
    else await expect(action).rejects.toMatchObject({ status: 502, message: expect.stringContaining("recording continuation superseded") });

    expect(injected).toBe(true);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    expect(h.telnyx.of("conference:unhold")).toHaveLength(0);
  });

  it("still fences termination committed after checkpoint RETURNING and before provider dispatch", async () => {
    const { h, call } = await heldCall();
    const update = h.db.update.bind(h.db);
    let checkpointReturned = false;
    vi.spyOn(h.db, "update").mockImplementation((table, values, filter) => {
      const rows = update(table, values, filter);
      if (table === "motorist_call_sessions" && isStartCheckpoint(values)) checkpointReturned = true;
      return rows;
    });
    const prepare = h.db.rpcHandlers.get("motorist_provider_command_prepare_v2")!;
    let fenced = false;
    h.db.registerRpc("motorist_provider_command_prepare_v2", (args, db) => {
      if (String(args.p_path).endsWith("/actions/unhold")) {
        expect(checkpointReturned).toBe(true);
        expect(h.session(call.sessionId).termination_requested_at).toBeFalsy();
        update("motorist_call_sessions", { termination_requested_at: h.now().toISOString() }, row => row.id === call.sessionId);
        fenced = true;
      }
      return prepare(args, db);
    });

    await expect(unholdCall(h.deps, actor, call.sessionId)).resolves.toMatchObject({ ignored: null });

    expect(fenced).toBe(true);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    expect(h.telnyx.of("conference:unhold")).toHaveLength(0);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries
      .some(entry => entry.commands.some(command => command.kind === "conference_unhold"))).toBe(false);
  });
});
