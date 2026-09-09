import { afterEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCEMENT_LANGUAGES, defaultAnnouncementConfig, type AnnouncementLanguage } from "@/lib/telephony/announcements";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { runSessionEvent } from "../session-runner";
import { readMeta, type SessionRow } from "./types";

afterEach(() => vi.unstubAllEnvs());
function setup(language: AnnouncementLanguage = "sk", quality = false) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
  for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(key, "true");
  const h = createTelephonyHarness();
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, quality_enabled: quality });
  h.db.update("motorist_telephony_lines", { metadata: { announcements: { ...defaultAnnouncementConfig(), language } } }, () => true);
  return h;
}

describe("one verified inbound welcome and recording notice", () => {
  it.each(ANNOUNCEMENT_LANGUAGES.flatMap(({ code }) => [false, true].map((quality) => ({ language: code, quality }))))("routes only after the full $language intro for quality=$quality", async ({ language, quality }) => {
    const h = setup(language, quality);
    const call = await h.inbound({ completeGreeting: false });
    const notice = quality ? "recordingNotice" : "recordingServiceNotice";
    const introduction = h.telnyx.of("playbackStart")[0];
    expect(introduction.params.audioUrl).toContain(`/announcements-intro-v1/${language}/greeting-${notice}.mp3`);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.noticeCompletedAt).toBeNull();
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id: "early-intro-poll", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: introduction.params.clientState });
    expect(h.telnyx.of("playbackStart").filter((entry) => String(entry.params.audioUrl).includes(notice))).toHaveLength(1);
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence ?? null).toBeNull();
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.noticeCompletedAt).toBeTruthy();
    const dials = h.telnyx.of("dial").length;
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: introduction.params.clientState });
    expect(h.telnyx.of("dial")).toHaveLength(dials);
  });

  it("does not bypass a speech retry with a stale audio completion", async () => {
    const h = setup(), call = await h.inbound({ completeGreeting: false });
    const intro = h.telnyx.of("playbackStart")[0];
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "failed", client_state: intro.params.clientState });
    const speech = h.telnyx.of("speak")[0];
    expect(speech.params.payload).toContain("Pomoc motoristom, dobrý deň.");
    expect(speech.params.payload).toContain("Naša spoločnosť hovor nahráva na vybavenie pomoci.");
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: intro.params.clientState });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "completed", client_state: speech.params.clientState });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.noticeCompletedAt).toBeTruthy();
  });

  it("continues assistance without recording when both combined playback and speech fail", async () => {
    const h = setup();
    h.telnyx.failAlways("playbackStart");
    h.telnyx.failAlways("speak");
    const call = await h.inbound({ completeGreeting: false });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording).toMatchObject({ noticeFailed: true, noticeCompletedAt: null });
    const operator = h.legFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(operator.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("recordingStart")).toHaveLength(0);
  });

  it("keeps the ordinary welcome when recording proof is disabled", async () => {
    const h = setup();
    vi.stubEnv("TELNYX_RECORDING_CONTRACT_VERIFIED", "false");
    const call = await h.inbound();
    expect(h.telnyx.of("playbackStart")[0].params.audioUrl).toContain("/announcements-v4/sk/greeting.mp3");
    expect(readMeta(h.session(call.sessionId) as SessionRow).greeting?.recording_notice).toBeUndefined();
  });

  it.each([false, true])("records phase timestamps separately from provider event time (durable=%s)", async (durable) => {
    const h = setup();
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", String(durable));
    const call = await h.inbound();
    const events = h.db.rows("motorist_call_events");
    const greeting = events.map((row) => row.normalized_payload as { session_id?: string; timing?: { runner_started_at: string; completed_at: string; lease_wait_ms: number; processing_ms: number }; commands?: Array<{ phase?: string; started_at?: string; effect_ms?: number }> })
      .find((row) => row.session_id === call.sessionId && row.commands?.some((command) => command.phase === "announcement:greeting+recordingServiceNotice"))!;
    expect(greeting.timing).toMatchObject({ runner_started_at: expect.any(String), completed_at: expect.any(String), lease_wait_ms: expect.any(Number), processing_ms: expect.any(Number) });
    expect(greeting.commands).toEqual(expect.arrayContaining([expect.objectContaining({ started_at: expect.any(String), effect_ms: expect.any(Number) })]));
  });
});
