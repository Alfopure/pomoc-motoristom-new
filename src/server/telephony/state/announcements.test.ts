import { describe, expect, it } from "vitest";

import { createTelephonyHarness, LINES, NUMBERS } from "@/test/telephony-harness";
import { defaultAnnouncementConfig } from "@/lib/telephony/announcements";
import { sweepOverdueRingSteps } from "../routing/ring-plan";
import { runSessionEvent } from "../session-runner";

describe("inbound introduction", () => {
  it("finishes the introduction before operators ring or waiting music starts", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ completeGreeting: false });
    expect(h.session(call.sessionId).state).toBe("greeting");
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(0);

    const prompt = h.telnyx.of("playbackStart")[0];
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed" });
    expect(h.session(call.sessionId).state).toBe("greeting");

    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: prompt.params.clientState });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(h.telnyx.of("playbackStart")).toHaveLength(2);

    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: prompt.params.clientState });
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });

  it.each([
    { to: NUMBERS.neutral, now: "2026-09-03T08:00:00.000Z", state: "ivr" },
    { to: NUMBERS.allianz, now: "2026-09-03T21:00:00.000Z", state: "after_hours" },
  ])("plays the introduction before $state", async ({ to, now, state }) => {
    const h = createTelephonyHarness({ now });
    const call = await h.inbound({ to, completeGreeting: false });
    expect(h.session(call.sessionId).state).toBe("greeting");
    expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(0);
    const prompt = h.telnyx.of("playbackStart")[0];
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: prompt.params.clientState });
    expect(h.session(call.sessionId).state).toBe(state);
    expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(1);
  });

  it("uses speech when media is unavailable and waits for speak.ended", async () => {
    const h = createTelephonyHarness({ mediaBaseUrl: null });
    const call = await h.inbound({ completeGreeting: false });
    const speech = h.telnyx.of("speak")[0];
    expect(speech.params.payload).toEqual(expect.any(String));
    expect(h.telnyx.of("dial")).toHaveLength(0);
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "completed", client_state: speech.params.clientState });
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("retries a missing audio file as speech without connecting the caller early", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ completeGreeting: false });
    const audio = h.telnyx.of("playbackStart")[0];
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "file_not_found", client_state: audio.params.clientState });
    expect(h.telnyx.of("speak")).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: audio.params.clientState });
    expect(h.session(call.sessionId).state).toBe("greeting");
    const speech = h.telnyx.of("speak")[0];
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "completed", client_state: speech.params.clientState });
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("leaves a callback when both audio and speech fail", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ completeGreeting: false });
    const audio = h.telnyx.of("playbackStart")[0];
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "failed", client_state: audio.params.clientState });
    const speech = h.telnyx.of("speak")[0];
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "failed", client_state: speech.params.clientState });
    expect(h.session(call.sessionId)).toMatchObject({ state: "greeting", ended_at: null, metadata: { greeting: { closing: true } } });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId).state).toBe("failed");
    expect(h.call(call.sessionId)).toMatchObject({ status: "failed", end_reason: "greeting_failed" });
  });

  it("retries a failed hangup through the existing sweep until the caller's departure is confirmed", async () => {
    const h = createTelephonyHarness({ mediaBaseUrl: null });
    const call = await h.inbound({ completeGreeting: false });
    const speech = h.telnyx.of("speak")[0];
    h.telnyx.failNext("hangup", "network unavailable");
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "failed", client_state: speech.params.clientState });
    expect(h.session(call.sessionId)).toMatchObject({ state: "greeting", ended_at: null, metadata: { greeting: { closing: true } } });
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "completed", client_state: speech.params.clientState });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    h.advance(31_000);
    const result = await sweepOverdueRingSteps({ admin: h.admin, organizationId: h.deps.organizationId, now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    expect(result.swept).toContain(call.sessionId);
    expect(h.telnyx.of("hangup")).toHaveLength(2);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId).state).toBe("failed");
    expect(h.call(call.sessionId)).toMatchObject({ status: "failed", end_reason: "greeting_failed" });
  });

  it("freezes the line language before later settings edits and localizes legacy IVR files", async () => {
    const h = createTelephonyHarness();
    const announcements = { ...defaultAnnouncementConfig(), language: "en" };
    h.db.update("motorist_telephony_lines", { metadata: { announcements } }, (row) => row.id === LINES.neutral);
    const call = await h.inbound({ to: NUMBERS.neutral, completeGreeting: false });
    const prompt = h.telnyx.of("playbackStart")[0];
    expect(prompt.params.audioUrl).toBe("https://media.test/telephony/announcements-v1/en/greeting.mp3");
    h.db.update("motorist_telephony_lines", { metadata: { announcements: { ...announcements, language: "de" } } }, (row) => row.id === LINES.neutral);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: prompt.params.clientState });
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params).toMatchObject({
      audioUrl: "https://media.test/telephony/announcements-v1/en/ivr-main.mp3",
      invalidAudioUrl: "https://media.test/telephony/announcements-v1/en/invalid-input.mp3",
    });
  });

  it("uses edited text immediately without replaying the old audio", async () => {
    const h = createTelephonyHarness();
    const announcements = { ...defaultAnnouncementConfig(), language: "de", prompts: { de: { greeting: { text: "Willkommen. Bitte warten Sie kurz." } } } };
    h.db.update("motorist_telephony_lines", { metadata: { announcements } }, (row) => row.id === LINES.allianz);
    await h.inbound({ completeGreeting: false });
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    expect(h.telnyx.of("speak")[0].params).toMatchObject({ payload: "Willkommen. Bitte warten Sie kurz.", voice: "Azure.de-DE-KatjaNeural" });
  });

  it("allows a longer custom introduction to finish before its watchdog retries", async () => {
    const h = createTelephonyHarness();
    const announcements = { ...defaultAnnouncementConfig(), prompts: { sk: { greeting: { text: "Prosím zostaňte na linke. ".repeat(20).trim() } } } };
    h.db.update("motorist_telephony_lines", { metadata: { announcements } }, (row) => row.id === LINES.allianz);
    const call = await h.inbound({ completeGreeting: false });
    h.advance(46_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: "long-greeting-sweep", type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.telnyx.of("speak")).toHaveLength(1);
    expect(h.session(call.sessionId).state).toBe("greeting");
  });

  it("plays generated absolute URLs without requiring a media base", async () => {
    const h = createTelephonyHarness({ mediaBaseUrl: null });
    const config = defaultAnnouncementConfig();
    const announcements = { ...config, prompts: { sk: { greeting: { text: "Pomoc motoristom. Dobrý deň.", voiceId: config.voiceId, audioUrl: "https://audio.test/generated.mp3" } } } };
    h.db.update("motorist_telephony_lines", { metadata: { announcements } }, (row) => row.id === LINES.allianz);
    await h.inbound({ completeGreeting: false });
    expect(h.telnyx.of("playbackStart")[0].params.audioUrl).toBe("https://audio.test/generated.mp3");
    expect(h.telnyx.of("speak")).toHaveLength(0);
  });

  it("uses edited invalid-input text even while the main menu still has default audio", async () => {
    const h = createTelephonyHarness();
    const announcements = { ...defaultAnnouncementConfig(), prompts: { sk: { invalidInput: { text: "Prosím, stlačte jednotku alebo dvojku." } } } };
    h.db.update("motorist_telephony_lines", { metadata: { announcements } }, (row) => row.id === LINES.neutral);
    await h.inbound({ to: NUMBERS.neutral });
    expect(h.telnyx.of("gatherUsingSpeak").at(-1)?.params.invalidPayload).toBe("Prosím, stlačte jednotku alebo dvojku.");
  });

  it("retains a custom IVR recording and speaks callback confirmation when media is absent", async () => {
    const h = createTelephonyHarness({ mediaBaseUrl: null });
    h.db.update("motorist_ivr_menus", { prompt_media_url: "https://audio.test/custom-menu.mp3", invalid_media_url: "invalid-input.mp3", tts_text: "Older menu fallback" }, () => true);
    const call = await h.inbound({ to: NUMBERS.neutral });
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params.audioUrl).toBe("https://audio.test/custom-menu.mp3");
    const menu = h.telnyx.of("gatherUsingAudio").at(-1)!;
    h.db.update("motorist_ivr_options", { prompt_media_url: null }, (row) => row.digit === "2");
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "valid", digits: "2", client_state: menu.params.clientState });
    expect(h.telnyx.of("speak").at(-1)?.params.payload).toContain("Vašu požiadavku");
    expect(h.telnyx.of("hangup")).toHaveLength(0);
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "completed" });
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
  });

  it("recovers a lost completion webhook through the existing sweep", async () => {
    const h = createTelephonyHarness({ mediaBaseUrl: null });
    const call = await h.inbound({ completeGreeting: false });
    const initialSpeech = h.telnyx.of("speak")[0];
    h.advance(46_000);
    const result = await sweepOverdueRingSteps({ admin: h.admin, organizationId: h.deps.organizationId, now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    expect(result.swept).toContain(call.sessionId);
    expect(h.telnyx.of("speak")).toHaveLength(2);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "cancelled", client_state: initialSpeech.params.clientState });
    expect(h.session(call.sessionId).state).toBe("greeting");
    h.advance(46_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: "second-timeout", type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.session(call.sessionId)).toMatchObject({ state: "greeting", metadata: { greeting: { closing: true } } });
  });
});
