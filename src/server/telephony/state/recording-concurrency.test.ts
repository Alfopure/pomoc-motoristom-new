import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { loadActiveCalls } from "../active-calls";
import { holdCall, unholdCall } from "../call-actions";
import { runSessionEvent } from "../session-runner";
import { TelnyxCommandError } from "../telnyx/client";
import { readMeta, type SessionRow } from "./types";

afterEach(() => vi.unstubAllEnvs());
async function setup(stable = false) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", String(stable));
  for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(key, "true");
  const h = createTelephonyHarness();
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  const state = () => readMeta(h.session(call.sessionId) as SessionRow).recording!;
  const snapshot = async () => (await loadActiveCalls({ ...h.deps, configured: true }, { profileId: PROFILES.o1, canManageAssignments: false })).calls.find((row) => row.sessionId === call.sessionId)!;
  const sweep = (id: string) => runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id, actorProfileId: null, occurredAt: h.now().toISOString() });
  return { h, call, operator, state, snapshot, sweep };
}

describe("recording commands concurrent with polling and provider bookkeeping", () => {
  it.each([false, true])("defers two contended polling clients during create without changing capture (durable=%s)", async (stable) => {
    const { h, call, operator, state, snapshot, sweep } = await setup(stable);
    const create = h.telnyx.client.createConference.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async (args) => {
      const response = await create(args);
      const before = state();
      expect((await snapshot()).audioConnection?.status).toBe("connecting");
      for (const id of ["poll-one", "poll-two"]) {
        expect(await sweep(id)).toMatchObject({ outcome: "ignored", leaseAcquired: false });
        expect(state()).toEqual(before);
      }
      return response;
    });
    expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
    expect(h.telnyx.of("recordingStop")).toHaveLength(0);
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(h.telnyx.of("conference:join")).toHaveLength(1);
    expect(state()).toMatchObject({ epoch: 0, pendingAudio: null, suppressionReason: null });
    expect((await snapshot()).audioConnection).toMatchObject({ status: "connected", confirmedAt: expect.any(String) });
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("adopts a benign conference.created version update before the create response", async () => {
    const { h, operator, call, state } = await setup();
    const create = h.telnyx.client.createConference.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async (args) => {
      const response = await create(args);
      expect((await h.legEvent(call.callControlId, "conference.created", { conference_id: response.id })).outcome).toBe("processed");
      return response;
    });
    expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
    expect(state().pendingAudio).toBeNull();
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(h.telnyx.of("conference:join")).toHaveLength(1);
  });

  it("compares persisted command identity independently of PostgreSQL JSONB key order", async () => {
    const { h, operator, call, state } = await setup();
    const create = h.telnyx.client.createConference.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async (args) => {
      const response = await create(args);
      const pending = state().pendingAudio!;
      const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)).map(([key, entry]) => [key, reorder(entry)])) : value;
      h.db.update("motorist_call_sessions", { metadata: { ...readMeta(h.session(call.sessionId) as SessionRow), recording: { ...state(), pendingAudio: { ...pending, commands: reorder(pending.commands) } } } }, (row) => row.id === call.sessionId);
      return response;
    });
    expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
    expect(h.telnyx.of("conference:join")).toHaveLength(1);
    expect(state().pendingAudio).toBeNull();
  });

  it.each(["version", "poll"])("preserves a valid recorder during its media settle interval: %s", async (race) => {
    const { h, operator, call, state, sweep } = await setup();
    const sleep = h.deps.sleep!;
    let injected = false;
    h.deps.sleep = async (ms) => {
      await sleep(ms);
      if (injected || ms !== 600 || !state().pendingAudio) return;
      injected = true;
      if (race === "poll") expect(await sweep("settle-poll")).toMatchObject({ outcome: "ignored", leaseAcquired: false });
      else h.db.update("motorist_call_sessions", { version: Number(h.session(call.sessionId).version) + 1 }, (row) => row.id === call.sessionId);
    };
    expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
    expect(injected).toBe(true);
    expect(h.telnyx.of("recordingStop")).toHaveLength(0);
    expect(h.telnyx.of("conference:join")).toHaveLength(1);
    expect(state().recorders[0].observed).toBe("recording");
  });

  it.each(["owner", "epoch", "objection", "hangup"])("still cancels a connection superseded by %s during create", async (reason) => {
    const { h, operator, call, state } = await setup();
    const create = h.telnyx.client.createConference.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async (args) => {
      const response = await create(args);
      const session = h.session(call.sessionId) as SessionRow;
      h.db.update("motorist_call_sessions", { version: session.version + 1,
        ...(reason === "owner" ? { answered_by_profile_id: PROFILES.o2 } : {}),
        ...(reason === "hangup" ? { ended_at: h.now().toISOString() } : {}),
        metadata: { ...readMeta(session), recording: { ...state(),
          ...(reason === "epoch" ? { epoch: state().epoch + 1 } : {}),
          ...(reason === "objection" ? { suppressionReason: "objection" } : {}) } },
      }, (row) => row.id === call.sessionId);
      return response;
    });
    expect(await h.legEvent(operator, "call.answered")).toMatchObject({ outcome: "failed", error: "recording continuation superseded; delayed audio action cancelled" });
    expect(h.telnyx.of("conference:join")).toHaveLength(0);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.db.rows("motorist_job_incidents")).toHaveLength(0);
  });

  it("shows unconfirmed membership as connecting, then delayed, and recovers with the same commands", async () => {
    const { h, operator, state, snapshot, sweep } = await setup();
    h.telnyx.failNext("conference:join", new TelnyxCommandError({ code: "timeout", status: 504 }));
    expect((await h.legEvent(operator, "call.answered")).outcome).toBe("failed");
    expect(state().connection?.confirmedAt).toBeNull();
    expect((await snapshot()).audioConnection?.status).toBe("connecting");
    h.advance(31_000);
    expect((await snapshot()).audioConnection).toMatchObject({ status: "failed", error: "connection_confirmation_timeout" });
    await sweep("retry-join");
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    const joins = h.telnyx.of("conference:join");
    expect(joins).toHaveLength(2);
    expect(joins[0].params.commandId).toBe(joins[1].params.commandId);
    expect((await snapshot()).audioConnection?.status).toBe("connected");
  });

  it("does not expose stale connection evidence after operator or conference changes", async () => {
    const { h, operator, call, snapshot } = await setup();
    await h.legEvent(operator, "call.answered");
    const session = h.session(call.sessionId);
    expect((await snapshot()).audioConnection?.status).toBe("connected");
    h.db.update("motorist_call_sessions", { answered_by_profile_id: PROFILES.o2 }, (row) => row.id === call.sessionId);
    expect((await snapshot()).audioConnection).toBeNull();
    h.db.update("motorist_call_sessions", { answered_by_profile_id: session.answered_by_profile_id, conference_id: "other-conference" }, (row) => row.id === call.sessionId);
    expect((await snapshot()).audioConnection).toBeNull();
  });

  it("keeps temporary hold rejection distinct from connection failure", async () => {
    const { h, operator, call, snapshot } = await setup();
    const create = h.telnyx.client.createConference.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async (args) => {
      const response = await create(args);
      await expect(runSessionEvent(h.deps, call.sessionId, { kind: "app", id: "busy-hold", type: "hold", actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString() }))
        .rejects.toMatchObject({ status: 503, message: "Prebieha zmena nahrávania. Zopakujte akciu o chvíľu." });
      return response;
    });
    expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
    expect((await snapshot()).audioConnection?.status).toBe("connected");
  });

  it.each(["start", "stop"])("retries only the database acknowledgement when recording %s meets a CAS conflict", async (phase) => {
    const { h, operator, call, state } = await setup();
    if (phase === "stop") await h.legEvent(operator, "call.answered");
    const update = h.db.update.bind(h.db);
    let raced = false;
    vi.spyOn(h.db, "update").mockImplementation((table, values, filter) => {
      const recording = (values.metadata as { recording?: { recorders?: Array<{ observed: string }> } } | undefined)?.recording;
      if (!raced && table === "motorist_call_sessions" && recording?.recorders?.some((item) => item.observed === (phase === "start" ? "recording" : "stopped"))) {
        raced = true;
        update(table, { version: Number(h.session(call.sessionId).version) + 1 }, (row) => row.id === call.sessionId);
        return [];
      }
      return update(table, values, filter);
    });
    if (phase === "start") expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
    else {
      const result = await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "recording_stop", id: "object-after-cas", actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString() });
      expect(result).toMatchObject({ outcome: "applied", apply: { failed: false } });
    }
    expect(raced).toBe(true);
    expect(h.telnyx.of(phase === "start" ? "recordingStart" : "recordingStop")).toHaveLength(1);
    expect(state().recorders[0].observed).toBe(phase === "start" ? "recording" : "stopped");
  });

  it("lets an actual customer hangup preempt create without starting another recorder", async () => {
    const { h, operator, call, state } = await setup();
    const create = h.telnyx.client.createConference.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async (args) => {
      const response = await create(args);
      expect((await h.legEvent(call.callControlId, "call.hangup")).outcome).toBe("processed");
      return response;
    });
    await h.legEvent(operator, "call.answered");
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    expect(h.legs(call.sessionId).find((leg) => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
    expect(state().pendingAudio).toBeNull();
    expect(h.telnyx.of("conference:join")).toHaveLength(0);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
  });

  it("keeps an interrupted, never-confirmed attempt visible after its pending command was revoked", async () => {
    const { h, operator, call, state, snapshot } = await setup();
    h.telnyx.failNext("conference:join", new TelnyxCommandError({ code: "timeout", status: 504 }));
    await h.legEvent(operator, "call.answered");
    h.db.update("motorist_call_sessions", { metadata: { ...readMeta(h.session(call.sessionId) as SessionRow), recording: { ...state(), epoch: state().epoch + 1, pendingAudio: null } } }, (row) => row.id === call.sessionId);
    expect((await snapshot()).audioConnection).toMatchObject({ status: "failed", error: "connection_interrupted", confirmedAt: null });
  });

  it("does not unhold a customer after the operator hangs up during recorder settling", async () => {
    const { h, operator, call, state } = await setup();
    const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
    await h.legEvent(operator, "call.answered");
    await holdCall(h.deps, actor, call.sessionId);
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("held");
    const sleep = h.deps.sleep!;
    let injected = false;
    h.deps.sleep = async (ms) => {
      await sleep(ms);
      if (injected || ms !== 600 || !state().pendingAudio) return;
      injected = true;
      await h.legEvent(operator, "call.hangup");
    };
    await unholdCall(h.deps, actor, call.sessionId);
    await completeCallAnnouncements(h, call.sessionId);
    expect(injected).toBe(true);
    expect(h.telnyx.of("conference:unhold")).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe("waiting");
  });
});
