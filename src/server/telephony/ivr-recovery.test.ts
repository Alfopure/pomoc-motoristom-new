import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAnnouncementConfig, DEFAULT_ANNOUNCEMENT_TEXTS, type AnnouncementLanguage } from "@/lib/telephony/announcements";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { runSessionEvent } from "./session-runner";
import { sweepOverdueRingSteps } from "./routing/ring-plan";
import { TelnyxCommandError } from "./telnyx/client";

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden in IVR QA"); })));
afterEach(() => vi.unstubAllGlobals());

const lastGather = (h: TelephonyHarness) => h.telnyx.calls.filter(c => ["gatherUsingAudio", "gatherUsingSpeak", "gather"].includes(c.method)).at(-1)!;
const complete = (h: TelephonyHarness, cc: string, clientState: unknown, digits = "", status = digits ? "valid" : "timeout") =>
  h.legEvent(cc, "call.gather.ended", { status, digits, client_state: clientState });
async function sweep(h: TelephonyHarness) {
  const result = await sweepOverdueRingSteps({ admin: h.admin, organizationId: ORG, now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
  expect(result.errors).toEqual([]);
  return result;
}
async function waiting(custom: "audio" | "text" | null = null, from?: string) {
  const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
  if (custom) {
    const config = defaultAnnouncementConfig();
    config.prompts.sk = { queueWaiting: { text: "Zostaňte na linke. Pre spätné volanie stlačte jednotku.", ...(custom === "audio" ? { audioUrl: "https://audio.test/short-queue.mp3", voiceId: config.voiceId } : {}) } };
    h.db.update("motorist_telephony_lines", { metadata: { announcements: config } }, row => row.id === LINES.allianz);
  }
  for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
  const call = await h.inbound({ to: NUMBERS.allianz, from });
  const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
  await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
  expect(h.session(call.sessionId).state).toBe("waiting");
  return { h, call };
}

describe("audited callback and IVR regressions", () => {
  it.each<AnnouncementLanguage>(["sk", "cs", "en", "de"])("confirms the saved legacy callback in %s instead of offering it again", async language => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_lines", { metadata: { announcements: { ...defaultAnnouncementConfig(), language } } }, row => row.id === LINES.neutral);
    h.db.update("motorist_ivr_options", { prompt_media_url: "callback-offer.mp3" }, row => row.action === "callback");
    const call = await h.inbound({ to: NUMBERS.neutral });
    await complete(h, call.callControlId, lastGather(h).params.clientState, "2");
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(h.telnyx.of("playbackStart").at(-1)?.params.audioUrl).toBe(`https://media.test/telephony/announcements-v4/${language}/callback-confirmed.mp3`);
  });

  it.each([null, "anonymous", "sip:anonymous@invalid", "+123", "<script>123</script>"])("does not confirm or discard a caller whose number became %s", async callerNumber => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral });
    h.db.update("motorist_call_sessions", { caller_number: callerNumber }, row => row.id === call.sessionId);
    await complete(h, call.callControlId, lastGather(h).params.clientState, "2");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("hangup")).toHaveLength(0);
    expect(h.telnyx.of("playbackStart").some(c => String(c.params.audioUrl).includes("callback-confirmed"))).toBe(false);
    await h.legEvent(call.callControlId, "call.hangup");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it("retries rejected menu audio as localized speech with a distinct command ID", async () => {
    const h = createTelephonyHarness();
    h.telnyx.failNext("gatherUsingAudio", "audio rejected");
    const call = await h.inbound({ to: NUMBERS.neutral });
    expect(h.session(call.sessionId).state).toBe("ivr");
    const audio = h.telnyx.of("gatherUsingAudio").at(-1)!;
    const speech = h.telnyx.of("gatherUsingSpeak").at(-1)!;
    expect(speech?.params.payload).toBe(DEFAULT_ANNOUNCEMENT_TEXTS.sk.ivrMain);
    expect(speech?.params.commandId).not.toBe(audio.params.commandId);
    await complete(h, call.callControlId, audio.params.clientState);
    expect(h.session(call.sessionId).state).toBe("ivr");
    await complete(h, call.callControlId, speech.params.clientState, "1");
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("continues to assistance once when both menu commands fail", async () => {
    const h = createTelephonyHarness();
    h.telnyx.failNext("gatherUsingAudio", "audio rejected");
    h.telnyx.failNext("gatherUsingSpeak", "speech rejected");
    const call = await h.inbound({ to: NUMBERS.neutral });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(3);
    const old = h.telnyx.of("gatherUsingAudio").at(-1)!;
    await complete(h, call.callControlId, old.params.clientState, "2");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });

  it("finds a lost IVR completion in the actual scanner and routes to assistance", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral });
    h.advance(120_000);
    for (const id of Object.values(PROFILES)) h.touchDevice(id);
    expect((await sweep(h)).swept).toContain(call.sessionId);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });

  it("does not let an old menu completion answer a newer retry", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral });
    const old = lastGather(h).params.clientState;
    await complete(h, call.callControlId, old, "9", "invalid");
    const current = lastGather(h).params.clientState;
    await complete(h, call.callControlId, old, "2");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe("ivr");
    await complete(h, call.callControlId, current, "1");
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("does not recover or dial after the provider confirms the caller is gone", async () => {
    const h = createTelephonyHarness();
    h.telnyx.failNext("gatherUsingAudio", new TelnyxCommandError({ code: "90018", status: 422, detail: "This call is no longer active." }));
    const call = await h.inbound({ to: NUMBERS.neutral });
    const old = lastGather(h).params.clientState;
    h.advance(120_000);
    await sweep(h);
    await complete(h, call.callControlId, old, "1");
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.telnyx.of("gatherUsingSpeak")).toHaveLength(0);
  });

  it.each(["audio", "text"] as const)("keeps a minute of music between custom %s queue prompts", async custom => {
    const { h, call } = await waiting(custom);
    const prompt = lastGather(h);
    expect(prompt.params.timeoutMillis).toBe(1_000);
    const promptCount = h.telnyx.of(custom === "audio" ? "gatherUsingAudio" : "gatherUsingSpeak").length;
    h.advance(5_000);
    await complete(h, call.callControlId, prompt.params.clientState);
    const music = lastGather(h);
    expect(music.method).toBe("gather");
    expect(music.params).toMatchObject({ initialTimeoutMillis: 60_000, validDigits: "1" });
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ loop: "infinity", audioUrl: "https://media.test/telephony/announcements-v1/moh.mp3" });
    await complete(h, call.callControlId, prompt.params.clientState);
    expect(lastGather(h)).toBe(music);
    h.advance(60_000);
    await complete(h, call.callControlId, music.params.clientState);
    expect(h.telnyx.of(custom === "audio" ? "gatherUsingAudio" : "gatherUsingSpeak")).toHaveLength(promptCount + 1);
    expect(h.session(call.sessionId).state).toBe("waiting");
  });

  it("accepts callback during custom queue music", async () => {
    const { h, call } = await waiting("audio");
    await complete(h, call.callControlId, lastGather(h).params.clientState);
    await complete(h, call.callControlId, lastGather(h).params.clientState, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(h.session(call.sessionId).state).toBe("callback_offered");
  });

  it("preserves a custom callback confirmation recording", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_ivr_options", { prompt_media_url: "https://audio.test/our-confirmation.mp3" }, row => row.action === "callback");
    const call = await h.inbound({ to: NUMBERS.neutral });
    await complete(h, call.callControlId, lastGather(h).params.clientState, "2");
    expect(h.telnyx.of("playbackStart").at(-1)?.params.audioUrl).toBe("https://audio.test/our-confirmation.mp3");
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
  });

  it("routes an anonymous caller directly to assistance while open", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral, from: "anonymous" });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });

  it("uses a truthful closing message for an anonymous caller outside hours", async () => {
    const h = createTelephonyHarness({ now: "2026-09-03T21:00:00.000Z" });
    const call = await h.inbound({ from: "anonymous" });
    const closing = h.telnyx.of("playbackStart").at(-1)!;
    expect(closing.params.audioUrl).toContain("afterHoursNoCallback.mp3");
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: closing.params.clientState });
    expect(h.telnyx.of("hangup")).toHaveLength(1);
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it("does not offer an impossible callback to an anonymous waiting caller and retains the queue limit", async () => {
    const { h, call } = await waiting(null, "anonymous");
    expect(lastGather(h).params.audioUrl).toContain("holdReminder.mp3");
    await complete(h, call.callControlId, lastGather(h).params.clientState, "1");
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    h.advance(30 * 60_000);
    await sweep(h);
    const closing = h.telnyx.of("playbackStart").at(-1)!;
    expect(closing.params.audioUrl).toContain("all-busy.mp3");
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: closing.params.clientState });
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it("allows one invalid callback key retry, without treating a stale answer as confirmation", async () => {
    const h = createTelephonyHarness({ now: "2026-09-03T21:00:00.000Z" });
    const call = await h.inbound();
    const old = lastGather(h).params.clientState;
    await complete(h, call.callControlId, old, "9", "invalid");
    expect(h.telnyx.of("hangup")).toHaveLength(0);
    const current = lastGather(h).params.clientState;
    await complete(h, call.callControlId, old, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    await complete(h, call.callControlId, current, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
  });

  it("recovers asynchronous missing menu audio once, rejects the stale audio event and completes current speech", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral });
    const audio = lastGather(h);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "file_not_found", client_state: audio.params.clientState });
    const speech = lastGather(h);
    expect(speech.method).toBe("gatherUsingSpeak");
    await complete(h, call.callControlId, audio.params.clientState, "2");
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "file_not_found", client_state: audio.params.clientState });
    expect(h.telnyx.of("gatherUsingSpeak")).toHaveLength(1);
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    await complete(h, call.callControlId, speech.params.clientState, "1");
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("lets a long edited menu finish and ignores cancellation instead of treating it as a choice", async () => {
    const h = createTelephonyHarness();
    const config = defaultAnnouncementConfig();
    config.prompts.sk = { ivrMain: { text: "Zostaňte, prosím, na linke. ".repeat(22).trim() } };
    h.db.update("motorist_telephony_lines", { metadata: { announcements: config } }, row => row.id === LINES.neutral);
    const call = await h.inbound({ to: NUMBERS.neutral });
    const menu = lastGather(h);
    h.advance(46_000);
    await sweep(h);
    await complete(h, call.callControlId, menu.params.clientState, "2", "cancelled");
    expect(h.session(call.sessionId).state).toBe("ivr");
    expect(h.telnyx.of("dial")).toHaveLength(0);
    await complete(h, call.callControlId, menu.params.clientState, "2");
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
  });

  it("retains music cadence when the default composed queue file falls back to speech", async () => {
    const { h, call } = await waiting();
    const audio = lastGather(h);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "file_not_found", client_state: audio.params.clientState });
    expect(lastGather(h).method).toBe("gatherUsingSpeak");
    await complete(h, call.callControlId, lastGather(h).params.clientState);
    expect(lastGather(h).method).toBe("gather");
    expect(lastGather(h).params.initialTimeoutMillis).toBe(60_000);
  });

  it("does not restart speech on early invalid music digits or interrupt a connected operator with late failures", async () => {
    const { h, call } = await waiting("text");
    await complete(h, call.callControlId, lastGather(h).params.clientState);
    h.advance(5_000);
    await complete(h, call.callControlId, lastGather(h).params.clientState, "9", "invalid");
    expect(lastGather(h).method).toBe("gather");
    expect(lastGather(h).params.initialTimeoutMillis).toBe(55_000);
    const old = lastGather(h).params.clientState;
    h.setPresence(PROFILES.o1, { status: "available" });
    h.advance(5_000);
    await sweep(h);
    const operator = h.openLegFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(operator.telnyx_call_control_id), "call.answered");
    const commandCount = h.telnyx.calls.length;
    await h.legEvent(call.callControlId, "call.speak.ended", { status: "failed", client_state: old });
    await complete(h, call.callControlId, old, "1");
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.calls).toHaveLength(commandCount);
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it("backs off a persistently failed music gather and keeps recovery bounded", async () => {
    const { h, call } = await waiting("text");
    h.telnyx.failAlways("gather", "provider temporarily unavailable");
    await complete(h, call.callControlId, lastGather(h).params.clientState);
    expect(h.telnyx.of("gather")).toHaveLength(1);
    h.advance(10_000);
    await sweep(h);
    expect(h.telnyx.of("gather")).toHaveLength(1);
    h.advance(60_000);
    await sweep(h);
    expect(h.telnyx.of("gather")).toHaveLength(2);
    expect(h.session(call.sessionId).state).toBe("waiting");
  });

  it("recovers the persisted DTMF choice after a failed insert and a lost retry using the confirmation watchdog", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral });
    h.db.failNext("motorist_callback_requests", "insert", "database unavailable");
    await complete(h, call.callControlId, lastGather(h).params.clientState, "2");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    h.advance(60_000);
    await sweep(h);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(h.rows("motorist_callback_requests")[0].metadata).toMatchObject({ request: { digit: "2", context: "ivr" } });
    expect(h.telnyx.of("speak").at(-1)?.params.payload).toBe(DEFAULT_ANNOUNCEMENT_TEXTS.sk.callbackConfirmed);
    h.advance(60_000);
    await sweep(h);
    expect(h.telnyx.of("hangup")).toHaveLength(1);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
  });

  it("keeps callback persistence mandatory through repeated failures, including a persisted closing marker", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral });
    h.db.failNext("motorist_callback_requests", "insert", "database unavailable");
    await complete(h, call.callControlId, lastGather(h).params.clientState, "2");
    for (let attempt = 0; attempt < 2; attempt++) {
      h.advance(60_000);
      h.db.failNext("motorist_callback_requests", "insert", "database unavailable");
      await expect(runSessionEvent(h.deps, call.sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() })).rejects.toThrow("callback insert failed");
      expect(h.telnyx.of("hangup")).toHaveLength(0);
      expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    }
    h.advance(60_000);
    await sweep(h);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(h.telnyx.of("hangup")).toHaveLength(1);
    expect(h.rows("motorist_callback_requests")[0].metadata).toMatchObject({ request: { digit: "2", context: "ivr" } });
  });

  it("does not fabricate a digit when recovering an older confirmed callback", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral });
    const session = h.session(call.sessionId);
    h.db.update("motorist_call_sessions", { state: "callback_offered", metadata: { ...(session.metadata as object), gather: null, callback: { confirmed: true, source: "ivr" } } }, row => row.id === call.sessionId);
    h.advance(180_000);
    await sweep(h);
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(h.rows("motorist_callback_requests")[0].metadata).not.toHaveProperty("request");
    expect(h.telnyx.of("hangup")).toHaveLength(1);
  });
});
