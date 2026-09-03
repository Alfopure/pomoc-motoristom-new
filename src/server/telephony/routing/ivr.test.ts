import { describe, expect, it } from "vitest";

import { createTelephonyHarness, IVR_MENU_ID, NUMBERS, ORG, PLAN_ID } from "@/test/telephony-harness";

import type { IvrMenuRow, IvrOptionRow } from "../state/types";
import { decideIvr, findIvrOption, ivrGatherSpec, ivrMaxTries, ivrValidDigits, type IvrConfig } from "./ivr";

/**
 * The IVR engine twice: as a pure decision table (digit → action, retry budget,
 * broken targets) and end to end through the harness, where the same decisions
 * have to come out as real Telnyx commands.
 */

const NEUTRAL = "+4210232408700";

function menu(overrides: Partial<IvrMenuRow> = {}): IvrMenuRow {
  return {
    id: IVR_MENU_ID,
    organization_id: ORG,
    name: "Hlavné menu",
    prompt_media_url: "ivr-main.mp3",
    tts_text: "Stlačte 1 alebo 2.",
    invalid_media_url: "invalid-input.mp3",
    timeout_secs: 5,
    max_tries: 2,
    active: true,
    created_at: "2026-09-03T08:00:00.000Z",
    updated_at: "2026-09-03T08:00:00.000Z",
    ...overrides,
  };
}

function option(overrides: Partial<IvrOptionRow> = {}): IvrOptionRow {
  return {
    id: "option-1",
    organization_id: ORG,
    ivr_menu_id: IVR_MENU_ID,
    digit: "1",
    action: "ring_plan",
    target_ring_plan_id: PLAN_ID,
    target_number: null,
    label: "Dispečing",
    prompt_media_url: null,
    tts_text: null,
    created_at: "2026-09-03T08:00:00.000Z",
    updated_at: "2026-09-03T08:00:00.000Z",
    ...overrides,
  };
}

function config(options: IvrOptionRow[], menuOverrides: Partial<IvrMenuRow> = {}): IvrConfig {
  return { menu: menu(menuOverrides), options };
}

describe("ivr gather spec", () => {
  it("plays the recorded prompt and accepts only the digits the menu offers", () => {
    const spec = ivrGatherSpec(config([option(), option({ id: "option-2", digit: "2", action: "callback", target_ring_plan_id: null })]));

    expect(spec).toMatchObject({
      media: { file: "ivr-main.mp3" },
      invalidMedia: { file: "invalid-input.mp3" },
      validDigits: "12",
      minimumDigits: 1,
      maximumDigits: 1,
      // One gather is one prompt; the retry budget is counted by `decideIvr`.
      maximumTries: 1,
      timeoutMillis: 5000,
      purpose: "ivr",
    });
  });

  it("falls back to speech only when the menu has no recording", () => {
    const spec = ivrGatherSpec(config([option()], { prompt_media_url: null }));
    // `effects.ts` reads `media: null` + `ttsText` as `gather_using_speak`.
    expect(spec.media).toBeNull();
    expect(spec.ttsText).toBe("Stlačte 1 alebo 2.");

    // Neither a recording nor a text: the shipped Slovak menu is still better
    // than a silent gather.
    expect(ivrGatherSpec(config([option()], { prompt_media_url: null, tts_text: null })).media).toEqual({ key: "ivrMain" });
  });

  it("accepts any key when the menu has no options, and clamps the schema bounds", () => {
    expect(ivrValidDigits([])).toBe("");
    expect(ivrGatherSpec(config([])).validDigits).toBe("0123456789*#");
    expect(ivrMaxTries({ max_tries: 99 })).toBe(5);
    expect(ivrMaxTries({ max_tries: 0 })).toBe(1);
  });

  it("ignores a digit the keypad cannot send", () => {
    expect(ivrValidDigits([option({ digit: "A" }), option({ id: "b", digit: "#" })])).toBe("#");
    expect(findIvrOption([option()], " ")).toBeNull();
  });
});

describe("ivr decisions", () => {
  const options = [
    option(),
    option({ id: "option-2", digit: "2", action: "callback", target_ring_plan_id: null, label: "Spätné volanie", prompt_media_url: "callback-offer.mp3" }),
    option({ id: "option-3", digit: "3", action: "external_number", target_ring_plan_id: null, target_number: "+421900000000", label: "Partner" }),
    option({ id: "option-4", digit: "4", action: "waiting_room", target_ring_plan_id: null, label: "Počkám" }),
    option({ id: "option-5", digit: "5", action: "repeat", target_ring_plan_id: null, label: "Zopakovať" }),
    option({ id: "option-6", digit: "6", action: "hangup", target_ring_plan_id: null, label: "Odkaz", prompt_media_url: "odkaz.mp3" }),
  ];
  const decide = (digits: string, tries = 1, planIds: string[] = [PLAN_ID]) =>
    decideIvr({ config: config(options), outcome: { digits }, tries, availablePlanIds: planIds });

  it("maps every digit onto its action", () => {
    expect(decide("1")).toMatchObject({ kind: "ring_plan", planId: PLAN_ID, targetMissing: false });
    expect(decide("2")).toMatchObject({ kind: "callback", prompt: { file: "callback-offer.mp3" } });
    expect(decide("3")).toMatchObject({ kind: "external_number", number: "+421900000000" });
    expect(decide("4")).toMatchObject({ kind: "waiting_room" });
    expect(decide("6")).toMatchObject({ kind: "hangup", prompt: { file: "odkaz.mp3" } });
  });

  it("retries an unmapped digit until the menu's budget is spent", () => {
    expect(decide("9", 1)).toEqual({ kind: "retry", tries: 2, reason: "invalid_digit" });
    // `max_tries: 2` means the caller hears the menu twice, so the second
    // invalid digit routes to the line's plan instead of looping.
    expect(decide("9", 2)).toEqual({ kind: "default", reason: "tries_exhausted" });
  });

  it("retries on the Telnyx `invalid` status, which is how an unmapped key really arrives", () => {
    // `valid_digits` is the menu's own digits, so Telnyx answers a wrong key
    // with status `invalid` and the digit — not with `valid`.
    expect(decideIvr({ config: config(options), outcome: { digits: "9", invalid: true }, tries: 1, availablePlanIds: [PLAN_ID] })).toEqual({
      kind: "retry",
      tries: 2,
      reason: "invalid_digit",
    });
    expect(decideIvr({ config: config(options), outcome: { digits: "9", invalid: true }, tries: 2, availablePlanIds: [PLAN_ID] })).toEqual({
      kind: "default",
      reason: "tries_exhausted",
    });
    // The flag wins over the digit lookup: a menu edited between the gather and
    // the answer must not turn a refused key into a routing decision.
    expect(decideIvr({ config: config(options), outcome: { digits: "1", invalid: true }, tries: 1, availablePlanIds: [PLAN_ID] })).toMatchObject({ kind: "retry" });
  });

  it("counts the repeat option against the same budget", () => {
    expect(decide("5", 1)).toEqual({ kind: "retry", tries: 2, reason: "repeat" });
    expect(decide("5", 2)).toEqual({ kind: "default", reason: "tries_exhausted" });
    // A generous menu still stops eventually.
    expect(decideIvr({ config: config(options, { max_tries: 5 }), outcome: { digits: "5" }, tries: 5, availablePlanIds: [] })).toEqual({
      kind: "default",
      reason: "tries_exhausted",
    });
  });

  it("treats silence as 'route me to a human', never as an error", () => {
    expect(decide("", 1)).toEqual({ kind: "default", reason: "silence" });
    // Even on the last try silence is not retried: the caller has nothing to press.
    expect(decide("", 2)).toEqual({ kind: "default", reason: "silence" });
  });

  it("falls back to the line's plan when the option's target plan is gone", () => {
    expect(decide("1", 1, [])).toEqual({ kind: "ring_plan", option: options[0], planId: null, targetMissing: true });
    // An option that names no plan at all is the same story without the flag.
    expect(
      decideIvr({ config: config([option({ target_ring_plan_id: null })]), outcome: { digits: "1" }, tries: 1, availablePlanIds: [PLAN_ID] }),
    ).toMatchObject({ kind: "ring_plan", planId: null, targetMissing: false });
  });

  it("routes to the plan when the option is incomplete or the menu is empty", () => {
    expect(decideIvr({ config: config([option({ digit: "3", action: "external_number", target_ring_plan_id: null, target_number: null })]), outcome: { digits: "3" }, tries: 1, availablePlanIds: [] })).toEqual({
      kind: "default",
      reason: "option_incomplete",
    });
    expect(decideIvr({ config: config([]), outcome: { digits: "1" }, tries: 1, availablePlanIds: [] })).toEqual({ kind: "default", reason: "no_options" });
    expect(decideIvr({ config: null, outcome: { digits: "1" }, tries: 1, availablePlanIds: [] })).toEqual({ kind: "default", reason: "no_options" });
  });
});

describe("ivr through the pipeline", () => {
  async function ivrCall(harness: ReturnType<typeof createTelephonyHarness>, callControlId: string) {
    const call = await harness.inbound({ to: NEUTRAL, callControlId, telnyxSessionId: `tsess-${callControlId}` });
    expect(harness.session(call.sessionId).state).toBe("ivr");
    return call;
  }

  /**
   * The event Telnyx actually sends. `valid_digits` on the gather is exactly the
   * menu's own option digits, so a key outside it comes back as `invalid` (with
   * the digit) and never as `valid`; pressing nothing comes back as `timeout`.
   */
  async function press(harness: ReturnType<typeof createTelephonyHarness>, callControlId: string, digits: string) {
    const gather = harness.telnyx.of("gatherUsingAudio").at(-1)!;
    const validDigits = String(gather.params.validDigits ?? "");
    const status = !digits ? "timeout" : validDigits.includes(digits) ? "valid" : "invalid";
    return harness.legEvent(callControlId, "call.gather.ended", {
      digits,
      status,
      client_state: gather.params.clientState,
    });
  }

  it("routes a valid digit to the mapped ring plan", async () => {
    const h = createTelephonyHarness();
    const call = await ivrCall(h, "cc-ivr-valid");

    await press(h, call.callControlId, "1");

    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect((h.session(call.sessionId).metadata as { ivr: { chosen: string; action: string } }).ivr).toMatchObject({ chosen: "1", action: "ring_plan" });
  });

  it("replays the menu after an invalid digit and gives up on the second one", async () => {
    const h = createTelephonyHarness();
    const call = await ivrCall(h, "cc-ivr-invalid");

    await press(h, call.callControlId, "7");

    expect(h.session(call.sessionId).state).toBe("ivr");
    expect((h.session(call.sessionId).metadata as { ivr: { tries: number } }).ivr.tries).toBe(2);
    const replay = h.telnyx.of("gatherUsingAudio").at(-1)!;
    expect(replay.params).toMatchObject({ audioUrl: "https://media.test/telephony/ivr-main.mp3", invalidAudioUrl: "https://media.test/telephony/invalid-input.mp3" });
    expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(2);
    expect(h.telnyx.of("dial")).toHaveLength(0);

    await press(h, call.callControlId, "7");

    // The budget is spent: the caller reaches the line's ring plan instead of
    // hearing the menu for a third time.
    expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(2);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });

  it("routes silence to the line's ring plan", async () => {
    const h = createTelephonyHarness();
    const call = await ivrCall(h, "cc-ivr-silence");

    await press(h, call.callControlId, "");

    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(h.session(call.sessionId).ring_plan_id).toBe(PLAN_ID);
  });

  it("records the callback and plays the option's own confirmation for digit 2", async () => {
    const h = createTelephonyHarness();
    const call = await ivrCall(h, "cc-ivr-callback");

    await press(h, call.callControlId, "2");

    expect(h.session(call.sessionId).state).toBe("callback_offered");
    expect(h.rows("motorist_callback_requests")).toEqual([expect.objectContaining({ source: "ivr", session_id: call.sessionId, caller_number: NUMBERS.customer })]);
    expect(h.telnyx.of("playbackStart").at(-1)?.params.audioUrl).toBe("https://media.test/telephony/callback-offer.mp3");
  });

  it("still reaches an operator when the digit's ring plan was deleted", async () => {
    const h = createTelephonyHarness();
    // The seeded neutral line keeps the "Denný" plan; only the IVR option points
    // at a plan nobody can materialise any more.
    h.db.update("motorist_ivr_options", { target_ring_plan_id: "00000000-0000-4000-8000-0000000029ff" }, (row) => row.digit === "1");
    const call = await ivrCall(h, "cc-ivr-orphan");

    await press(h, call.callControlId, "1");

    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", ring_plan_id: PLAN_ID });
    expect(h.telnyx.of("dial")).toHaveLength(3);
    // The event log has to say the digit's own plan was missing, otherwise the
    // silent fallback would look like a correctly routed call.
    const notes = h.callEvents(call.sessionId).flatMap((row) => ((row.normalized_payload as { notes?: string[] }).notes ?? []));
    expect(notes).toContain("IVR 1: target plan is gone → line plan");
  });

  it("plays the closing message of a hangup option and ends the call after it", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_ivr_options", { action: "hangup", target_ring_plan_id: null, prompt_media_url: "after-hours.mp3", label: "Odkaz" }, (row) => row.digit === "1");
    const call = await ivrCall(h, "cc-ivr-message");

    await press(h, call.callControlId, "1");

    expect(h.telnyx.of("playbackStart").at(-1)?.params.audioUrl).toBe("https://media.test/telephony/after-hours.mp3");
    expect(h.telnyx.of("hangup")).toHaveLength(0);

    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed" });
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);

    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.call(call.sessionId)).toMatchObject({ status: "missed", end_reason: "ivr_message" });
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it("ends the call with the same outcome when the closing option has no recording", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_ivr_options", { action: "hangup", target_ring_plan_id: null, prompt_media_url: null, label: "Odkaz" }, (row) => row.digit === "1");
    const call = await ivrCall(h, "cc-ivr-message-silent");

    await press(h, call.callControlId, "1");

    // No recording → hang up straight away, but the call is still booked as a
    // message the app played, not as a caller we failed to reach: no callback
    // request, and the statistics count it as system-handled.
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
    expect(h.session(call.sessionId).state).toBe("missed");

    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.call(call.sessionId)).toMatchObject({ status: "missed", end_reason: "ivr_message" });
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });
});
