import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { defaultAnnouncementConfig, resolveAnnouncement } from "@/lib/telephony/announcements";
import { pickupWaitingCall, cancelConsult, completeTransfer, holdCall, startConsult, stopCallRecording, unholdCall, blindTransfer, addCallParty, reconcileCallRecordingPolicy, superviseCall, stopSupervisingCall } from "../call-actions";
import { effectsDeps, loadRoutingContext, loadSessionSnapshot, runSessionEvent } from "../session-runner";
import { applyReduceResult } from "./effects";
import { parseTelnyxEnvelope } from "./events";
import { TelnyxCommandError } from "../telnyx/client";
import { recordingCommandOutcome, recordingIntent } from "./recording";
import { summarizeSessionRecording, type RecordingState } from "./recording-types";
import { readMeta, type SessionRow } from "./types";
import { reduce } from "./transitions";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
afterEach(() => vi.unstubAllEnvs());

function enabledHarness(options: { conference?: boolean; transfer?: boolean; statusAnnouncements?: boolean; separateIntro?: boolean } = {}) {
  vi.stubEnv("TELNYX_RECORDING_ENABLED", "true");
  vi.stubEnv("TELNYX_RECORDING_CONTRACT_VERIFIED", "true");
  vi.stubEnv("RECORDING_PROCESSING_ENABLED", "true");
  vi.stubEnv("TELNYX_RECORDING_CONFERENCE_VERIFIED", options.conference ? "true" : "false");
  vi.stubEnv("TELNYX_RECORDING_TRANSFER_VERIFIED", options.transfer ? "true" : "false");
  const h = createTelephonyHarness();
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  if (options.statusAnnouncements !== undefined) h.db.update("motorist_telephony_lines", { metadata: { announcements: { ...defaultAnnouncementConfig(), recordingStatusAnnouncements: options.statusAnnouncements } } }, () => true);
  if (options.separateIntro) {
    const config = defaultAnnouncementConfig();
    config.prompts.sk = { greeting: { text: resolveAnnouncement(config, "greeting").text, audioUrl: "https://example.invalid/custom-greeting.mp3", voiceId: config.voiceId } };
    h.db.update("motorist_telephony_lines", { metadata: { announcements: config } }, () => true);
  }
  return h;
}

async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  await completeCallAnnouncements(h, call.sessionId);
  const winner = h.legFor(call.sessionId, PROFILES.o1)!;
  await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  return call;
}

describe("recording lifecycle", () => {
  it.each([false, true])("restores a recorded call after a private whisper with status announcements=%s", async statusAnnouncements => {
    const h = enabledHarness({ conference: true, statusAnnouncements }); const call = await talking(h);
    const manager = { profileId: PROFILES.o4, role: "manager" as const };
    h.db.seed("motorist_operator_devices", [{ organization_id: ORG, profile_id: manager.profileId, environment: "development", telnyx_credential_id: "test-supervisor", sip_username: "test-supervisor", credential_expires_at: null, device_seen_at: h.now().toISOString(), device_session_id: "test-supervisor-session", registration_state: "registered", metadata: {} }]);
    await superviseCall(h.deps, manager, call.sessionId, "whisper");
    const supervisor = h.legFor(call.sessionId, manager.profileId)!;
    await h.legEvent(String(supervisor.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("recordingStop")).toHaveLength(1);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    await stopSupervisingCall(h.deps, manager, call.sessionId);
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence?.keys ?? []).toEqual(statusAnnouncements ? ["recordingResumed"] : []);
    await completeCallAnnouncements(h, call.sessionId);
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence ?? null).toBeNull();
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
  });

  it.each([undefined, false, true])("stops on objection with status announcements=%s while preserving the actual stop and suppression", async statusAnnouncements => {
    const h = enabledHarness({ statusAnnouncements }); const call = await talking(h);
    const playbackBefore = h.telnyx.of("playbackStart").length;
    await stopCallRecording(h.deps, actor, call.sessionId);
    expect(h.telnyx.of("recordingStop")).toHaveLength(1);
    const metadata = readMeta(h.session(call.sessionId) as SessionRow);
    expect(metadata.recording?.barrier).toBeNull();
    expect(metadata.recording?.suppressionReason).toBe("objection");
    expect(metadata.announcement_sequence?.keys ?? []).toEqual(statusAnnouncements ? ["recordingPaused"] : []);
    expect(h.telnyx.of("playbackStart").slice(playbackBefore)).toHaveLength(statusAnnouncements ? 1 : 0);
    await completeCallAnnouncements(h, call.sessionId);
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata)).toEqual({ state: "stopped", suppressed: true });
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it.each([false, true])("requires a confirmed stop even when status announcements=%s", async statusAnnouncements => {
    const h = enabledHarness({ statusAnnouncements }); const call = await talking(h);
    const playbackBefore = h.telnyx.of("playbackStart").length;
    h.telnyx.failAlways("recordingStop", "timeout");
    await expect(stopCallRecording(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 502 });
    expect(h.telnyx.of("playbackStart")).toHaveLength(playbackBefore);
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence).toBeNull();
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("unknown");
  });

  it.each([false, true])("resumes held recording with status announcements=%s and no stalled continuation", async statusAnnouncements => {
    const h = enabledHarness({ conference: true, statusAnnouncements }); const call = await talking(h);
    await holdCall(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    await unholdCall(h.deps, actor, call.sessionId);
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence?.keys).toEqual(statusAnnouncements ? ["resume", "recordingResumed"] : ["resume"]);
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence).toBeNull();
  });

  it("keeps the preference captured at call start when the line changes mid-call", async () => {
    const h = enabledHarness({ statusAnnouncements: false }); const call = await talking(h);
    h.db.update("motorist_telephony_lines", { metadata: { announcements: { ...defaultAnnouncementConfig(), recordingStatusAnnouncements: true } } }, () => true);
    const playbackBefore = h.telnyx.of("playbackStart").length;
    await stopCallRecording(h.deps, actor, call.sessionId);
    expect(h.telnyx.of("playbackStart")).toHaveLength(playbackBefore);
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcements?.recordingStatusAnnouncements).toBe(false);
  });

  it("waits for the entire privacy notice and then starts capture before bridge", async () => {
    const h = enabledHarness();
    const call = await h.inbound({ completeGreeting: false });
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("notice");
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.telnyx.of("recordingStart")).toHaveLength(0);
    const introduction = h.telnyx.of("playbackStart").at(-1)!;
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: introduction.params.clientState });
    const winner = h.legFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
    const methods = h.telnyx.calls.map((entry) => entry.method);
    expect(methods.indexOf("recordingStart")).toBeGreaterThan(-1);
    expect(methods.indexOf("recordingStart")).toBeLessThan(methods.indexOf("bridge"));
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("recording");
  });

  it("does not activate recording without provider proof", async () => {
    const h = enabledHarness();
    vi.stubEnv("TELNYX_RECORDING_CONTRACT_VERIFIED", "false");
    const call = await talking(h);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("recordingStart")).toHaveLength(0);
  });

  it("chooses the editable notice matching the approved purpose", async () => {
    const service = enabledHarness();
    service.db.update("motorist_telephony_lines", { metadata: { announcements: { version: 1, language: "sk", voiceId: "EXAVITQu4vr4xnSDxMaL", prompts: { sk: { recordingServiceNotice: { text: "Tento hovor nahrávame na vybavenie vašej pomoci." } } } } } }, () => true);
    const first = await service.inbound();
    expect(readMeta(service.session(first.sessionId) as SessionRow).announcement_sequence?.keys).toEqual(["recordingServiceNotice"]);
    expect(service.telnyx.of("speak").at(-1)?.params.payload).toBe("Tento hovor nahrávame na vybavenie vašej pomoci.");
    const quality = enabledHarness();
    quality.db.update("motorist_call_recording_policies", { quality_enabled: true }, () => true);
    const second = await quality.inbound({ completeGreeting: false });
    expect(readMeta(quality.session(second.sessionId) as SessionRow).greeting?.recording_notice).toBe("recordingNotice");
    expect(quality.telnyx.of("playbackStart").at(-1)?.params.audioUrl).toContain("/greeting-recordingNotice.mp3");
  });

  it("does not execute a delayed bridge after a newer objection during media warmup", async () => {
    const h = enabledHarness(); const call = await h.inbound(); await completeCallAnnouncements(h, call.sessionId);
    h.deps.sleep = async (ms) => {
      h.advance(ms);
      if (ms !== 600) return;
      const current = h.session(call.sessionId) as SessionRow, meta = readMeta(current), state = meta.recording!;
      h.db.update("motorist_call_sessions", { version: current.version + 1, metadata: { ...meta, recording: { ...state, epoch: state.epoch + 1, suppressionReason: "objection", pendingAudio: null,
        recorders: state.recorders.map((item) => ({ ...item, desired: "stopped", observed: "stopped" })) } } }, (row) => row.id === call.sessionId);
    };
    const winner = h.legFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata)).toEqual({ state: "stopped", suppressed: true });
  });

  it("recovers a process interrupted after recorder readiness before its durable bridge", async () => {
    const h = enabledHarness(); const call = await h.inbound(); await completeCallAnnouncements(h, call.sessionId);
    const winner = h.legFor(call.sessionId, PROFILES.o1)!;
    const event = parseTelnyxEnvelope(h.envelope("call.answered", { call_control_id: winner.telnyx_call_control_id }))!;
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId), context = await loadRoutingContext(h.deps, snapshot.session);
    const result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, context);
    await applyReduceResult(effectsDeps(h.deps), { session: snapshot.session, result: { ...result, commands: result.commands.filter((command) => command.kind === "recording_start") }, event, expectedVersion: snapshot.session.version });
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.pendingAudio?.commands).toHaveLength(1);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: "recover-audio", type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.pendingAudio).toBeNull();
  });

  it("does not let duplicate greetings or early watchdogs bypass the pending privacy notice", async () => {
    const h = enabledHarness({ separateIntro: true });
    const call = await h.inbound();
    const greeting = h.telnyx.of("playbackStart")[0];
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: greeting.params.clientState });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    const { runSessionEvent } = await import("../session-runner");
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: "early-sweep", type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });

  it("falls back once after a missing notice completion and still helps after the second deadline", async () => {
    const h = enabledHarness({ separateIntro: true }); const call = await h.inbound();
    const { runSessionEvent } = await import("../session-runner");
    h.advance(46_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: "notice-sweep1", type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.telnyx.of("speak")).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    h.advance(46_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: "notice-sweep2", type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("recordingStart")).toHaveLength(0);
  });

  it("does not execute a delayed privacy action after its deadline", async () => {
    const h = enabledHarness({ conference: true }); const call = await talking(h);
    h.telnyx.failAlways("recordingStop");
    await expect(holdCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 502 });
    h.advance(6_000);
    const { runSessionEvent } = await import("../session-runner");
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: "barrier-expiry", type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.barrier).toBeNull();
  });

  it("continues normal assistance when audio AND locale TTS notice fail", async () => {
    const h = enabledHarness({ separateIntro: true });
    const call = await h.inbound({ completeGreeting: false });
    h.telnyx.failAlways("playbackStart"); h.telnyx.failAlways("speak");
    const greeting = h.telnyx.of("playbackStart")[0];
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: greeting.params.clientState });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("recordingStart")).toHaveLength(0);
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("failed");
    expect(h.telnyx.of("hangup")).toHaveLength(0);
  });

  it("keeps assistance connected after an ambiguous start failure and blocks private consultation", async () => {
    const h = enabledHarness({ conference: true });
    h.telnyx.failAlways("recordingStart", new TelnyxCommandError({ code: "timeout", status: 504, detail: "timeout" }));
    const call = await talking(h);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("unknown");
    h.telnyx.failAlways("recordingStop", "timeout");
    await expect(startConsult(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 })).rejects.toMatchObject({ status: 502 });
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("unknown");
  });

  it("continues assistance when START acknowledgement cannot be checkpointed", async () => {
    const h = enabledHarness();
    const start = h.telnyx.client.recordingStart.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "recordingStart").mockImplementation(async (params) => {
      const result = await start(params);
      h.db.failNext("motorist_call_sessions", "update", "checkpoint down");
      h.db.failNext("motorist_call_sessions", "update", "checkpoint still down");
      return result;
    });
    const call = await talking(h);
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("starting");
  });

  it("does not release a private action when STOP acknowledgement cannot be checkpointed", async () => {
    const h = enabledHarness({ conference: true }); const call = await talking(h);
    const stop = h.telnyx.client.recordingStop.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "recordingStop").mockImplementation(async (params) => {
      await stop(params);
      h.db.failNext("motorist_call_sessions", "update", "checkpoint down");
      h.db.failNext("motorist_call_sessions", "update", "checkpoint still down");
    });
    await expect(startConsult(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 })).rejects.toMatchObject({ status: 502 });
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("stopping");
  });

  it("converges a disabled policy immediately and on sweep without treating it as an objection", async () => {
    const h = enabledHarness(); const call = await talking(h);
    await h.deps.admin.from("motorist_call_recording_policies").update({ recording_enabled: false }).eq("organization_id", ORG);
    h.telnyx.failNext("recordingStop", "temporary failure");
    await reconcileCallRecordingPolicy(h.deps, call.sessionId);
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("unknown");
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: "policy-sweep", type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.telnyx.of("recordingStop")).toHaveLength(2);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.suppressionReason).toBe("topology");
    await completeCallAnnouncements(h, call.sessionId);
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata).state).toBe("stopped");
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
  });

  it("starts a fresh bounded segment after a matched duration-limit saved event", async () => {
    const h = enabledHarness(); const call = await talking(h);
    const recorder = readMeta(h.session(call.sessionId) as SessionRow).recording!.recorders[0];
    const event = parseTelnyxEnvelope(h.envelope("call.recording.saved", { call_control_id: call.callControlId,
      recording_id: recorder.providerRecordingId, recording_started_at: "2026-09-06T12:00:00.000Z", recording_ended_at: "2026-09-06T12:30:00.000Z" }))!;
    event.clientState = { sid: call.sessionId, role: "customer", intent: recordingIntent(recorder.id) };
    const foreign = { ...event, id: "foreign-recording", payload: { ...event.payload, recording_id: "not-the-requested-provider-id" } };
    expect((await runSessionEvent(h.deps, call.sessionId, foreign)).outcome).toBe("ignored");
    // Telnyx uses the latest call client_state on a saved event; a later
    // announcement must not detach the exact provider recording from its call.
    event.clientState.intent = "seq:later-prompt";
    await runSessionEvent(h.deps, call.sessionId, event);
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.recorders.map((item) => item.observed)).toEqual(["stopped", "recording"]);
    await runSessionEvent(h.deps, call.sessionId, event);
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
  });

  it("stops before hold and resumes as a new segment with verified conference capability", async () => {
    const h = enabledHarness({ conference: true });
    const call = await talking(h);
    await holdCall(h.deps, actor, call.sessionId);
    expect(h.telnyx.of("recordingStop")).toHaveLength(1);
    expect(h.session(call.sessionId).state).toBe("talking");
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("held");
    await unholdCall(h.deps, actor, call.sessionId);
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
    expect(h.telnyx.calls.findLastIndex((entry) => entry.method === "recordingStart")).toBeLessThan(h.telnyx.calls.findLastIndex((entry) => entry.method === "conference:unhold"));
  });

  it("keeps an unsupported conference unrecorded while hold and resume still work", async () => {
    const h = enabledHarness(); const call = await talking(h);
    await holdCall(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    await unholdCall(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
  });

  it("never resumes after an objection, including through a hold/unhold", async () => {
    const h = enabledHarness({ conference: true }); const call = await talking(h);
    await stopCallRecording(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    expect(summarizeSessionRecording(h.session(call.sessionId).metadata)).toEqual({ state: "stopped", suppressed: true });
    await holdCall(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    await unholdCall(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
  });

  it("excludes the private consult and starts a fresh segment after cancelling", async () => {
    const h = enabledHarness({ conference: true }); const call = await talking(h);
    await startConsult(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 }); await completeCallAnnouncements(h, call.sessionId);
    const consult = h.legs(call.sessionId).find((leg) => leg.role === "consult")!;
    await h.legEvent(String(consult.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    await cancelConsult(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
  });

  /** Prompts (audio or speech) played into one leg. */
  const promptsOn = (h: TelephonyHarness, callControlId: unknown) =>
    h.telnyx.calls.filter((entry) => (entry.method === "playbackStart" || entry.method === "speak") && entry.params.callControlId === callControlId);

  it("connects a colleague receiving a blind transfer without playing the customer notice", async () => {
    const h = enabledHarness({ transfer: true }); const call = await talking(h);
    await blindTransfer(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 }); await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.of("transfer")).toHaveLength(0);
    const target = h.openLegFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(target.telnyx_call_control_id), "call.answered");
    // Nothing is played into the colleague's ear; the customer is connected and recorded right away.
    expect(promptsOn(h, target.telnyx_call_control_id)).toHaveLength(0);
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence ?? null).toBeNull();
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
    expect(h.session(call.sessionId).answered_by_profile_id).toBe(PROFILES.o2);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.notifiedCallControlIds).toContain(target.telnyx_call_control_id);
  });

  it("informs an external blind-transfer target before bridging and recording its new segment", async () => {
    const h = enabledHarness({ transfer: true }); const call = await talking(h);
    await blindTransfer(h.deps, actor, call.sessionId, { number: "0900 000 000" }); await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.of("transfer")).toHaveLength(0);
    const target = h.legs(call.sessionId).find((leg) => leg.role === "external" && !leg.ended_at)!;
    await h.legEvent(String(target.telnyx_call_control_id), "call.answered");
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence?.callControlId).toBe(target.telnyx_call_control_id);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    await completeCallAnnouncements(h, call.sessionId);
    expect(promptsOn(h, target.telnyx_call_control_id)).toHaveLength(1);
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: null });
  });

  it.each([["operator", 0], ["external", 1]] as const)("plays the notice to a consulted %s before attended transfer only outside the team (%i prompts)", async (targetKind, prompts) => {
    const h = enabledHarness({ conference: true, transfer: true }); const call = await talking(h);
    await startConsult(h.deps, actor, call.sessionId, targetKind === "operator" ? { profileId: PROFILES.o2 } : { number: "0900 000 000" }); await completeCallAnnouncements(h, call.sessionId);
    const consult = h.legs(call.sessionId).find((leg) => leg.role === "consult")!;
    await h.legEvent(String(consult.telnyx_call_control_id), "call.answered");
    await completeTransfer(h.deps, actor, call.sessionId);
    expect(promptsOn(h, consult.telnyx_call_control_id)).toHaveLength(prompts);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
    expect(h.telnyx.of("conference:unhold")).toHaveLength(1);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.pendingAudio).toBeNull();
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.notifiedCallControlIds).toContain(consult.telnyx_call_control_id);
  });

  it("does not record a new external conference participant until its notice finishes", async () => {
    const h = enabledHarness({ conference: true }); const call = await talking(h);
    await addCallParty(h.deps, actor, call.sessionId, { number: "0900 000 000" }); await completeCallAnnouncements(h, call.sessionId);
    const party = h.legs(call.sessionId).find((leg) => leg.role === "external" && !leg.ended_at)!;
    await h.legEvent(String(party.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("conference:join").some((command) => command.params.call_control_id === party.telnyx_call_control_id)).toBe(false);
    await completeCallAnnouncements(h, call.sessionId);
    expect(promptsOn(h, party.telnyx_call_control_id)).toHaveLength(1);
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
    expect(h.telnyx.of("conference:join").some((command) => command.params.call_control_id === party.telnyx_call_control_id)).toBe(true);
  });

  it("joins a colleague added to the conference without the customer notice and records again", async () => {
    const h = enabledHarness({ conference: true }); const call = await talking(h);
    await addCallParty(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 }); await completeCallAnnouncements(h, call.sessionId);
    const party = h.openLegFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(party.telnyx_call_control_id), "call.answered");
    expect(promptsOn(h, party.telnyx_call_control_id)).toHaveLength(0);
    expect(h.telnyx.of("conference:join").some((command) => command.params.call_control_id === party.telnyx_call_control_id)).toBe(true);
    expect(h.telnyx.of("recordingStart")).toHaveLength(2);
    expect(h.session(call.sessionId).state).toBe("conference");
  });

  it("ignores stale command acknowledgements and does not invent a stopped webhook", async () => {
    const h = enabledHarness(); const call = await talking(h);
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const state = readMeta(snapshot.session).recording!;
    const recorder = state.recorders[0];
    const suppressed = { ...snapshot.session, metadata: { recording: { ...state, epoch: state.epoch + 1, suppressionReason: "objection", recorders: [{ ...recorder, desired: "stopped", observed: "stopping" }] } } } as unknown as SessionRow;
    const after = recordingCommandOutcome(suppressed, { kind: "recording_start", commandId: recorder.startCommandId, leg: { callControlId: call.callControlId }, recorderId: recorder.id, epoch: recorder.epoch, maxLength: 1800 }, true, h.now().toISOString());
    expect((readMeta(after).recording as RecordingState).recorders[0].observed).toBe("stopping");
    const context = await loadRoutingContext(h.deps, snapshot.session);
    const raw = h.envelope("call.recording.stopped", { call_control_id: call.callControlId });
    const { parseTelnyxEnvelope } = await import("./events");
    const result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, parseTelnyxEnvelope(raw)!, context);
    expect(result.ignored).toContain("no transition");
    expect(recordingIntent(recorder.id).length).toBeLessThanOrEqual(32);
  });
});


describe("mobile answer with active recording policy", () => {
  it.each(["mobile", "web"])("keeps the %s winner and recording intact after the other device answers late", async (winner) => {
    const h = enabledHarness({ conference: true });
    h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: actor.profileId, environment: "development", sip_username: "mobile-operator", device_seen_at: h.now().toISOString(), registration_state: "registered" }]);
    const call = await h.inbound(); await completeCallAnnouncements(h, call.sessionId);
    const original = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
    const mobile = await pickupWaitingCall({ ...h.deps, deviceKind: "mobile" }, actor, call.sessionId);
    const accepted = winner === "mobile" ? mobile.operatorLegCallControlId! : original;
    const loser = winner === "mobile" ? original : mobile.operatorLegCallControlId!;
    await h.legEvent(accepted, "call.answered");
    const recording = structuredClone(readMeta(h.session(call.sessionId) as SessionRow).recording);
    const stops = h.telnyx.of("recordingStop").length;
    await h.legEvent(loser, "call.answered"); await h.legEvent(loser, "call.hangup");
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(readMeta(h.session(call.sessionId) as SessionRow).answered_leg_call_control_id).toBe(accepted);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording).toEqual(recording);
    expect(h.telnyx.of("recordingStop")).toHaveLength(stops);
    expect(h.telnyx.of("hangup").some((command) => command.params.callControlId === accepted)).toBe(false);
  });
});
