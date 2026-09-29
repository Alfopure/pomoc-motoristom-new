import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type HarnessOptions, type TelephonyHarness } from "@/test/telephony-harness";
import { blindTransfer, deferRingingCall, holdCall, parkCall, pickupWaitingCall } from "../call-actions";
import { readMeta, type SessionRow } from "./types";

const RINGBACK = "https://media.test/telephony/tones-v1/ringback.mp3";
const MUSIC = "https://media.test/telephony/announcements-v1/moh.mp3";
const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const MODES = [
  { name: "compatibility", stable: false, options: {} },
  { name: "stability contract 1", stable: true, options: {} },
  { name: "stability contract 2", stable: true, options: { writerContract: 2 as const } },
];

afterEach(() => vi.unstubAllEnvs());

const ringbacks = (h: TelephonyHarness) => h.telnyx.of("playbackStart").filter(entry => entry.params.audioUrl === RINGBACK);
const sessionMeta = (h: TelephonyHarness, sessionId: string) => readMeta(h.session(sessionId) as SessionRow);

async function rejectOpenOffers(h: TelephonyHarness, sessionId: string) {
  for (const leg of h.legs(sessionId).filter(row => row.role !== "customer" && !row.ended_at)) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
  }
}

async function answer(h: TelephonyHarness, sessionId: string) {
  const operator = String(h.openLegFor(sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  await h.legEvent(operator, "call.answered");
  return operator;
}

describe.each(MODES)("inbound caller ringback: $name", ({ stable, options }) => {
  function world(extra: HarnessOptions = {}) {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", String(stable));
    const h = createTelephonyHarness({ ...options, ...extra });
    // Isolate the ringing phase from the optional greeting and recording notice.
    h.db.update("motorist_telephony_lines", { metadata: {} }, () => true);
    return h;
  }

  it.each(stable ? ["browser", "personal mobile"] : ["browser"])("plays one loop while ringing the %s and bridges before stopping it", async delivery => {
    const h = world();
    if (delivery === "personal mobile") {
      h.db.update("motorist_operator_telephony_settings", { delivery_mode: "personal_mobile", default_mobile_number: "+421911222333" }, row => row.profile_id === PROFILES.o1);
    }
    const call = await h.inbound();
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(ringbacks(h)).toHaveLength(1);
    expect(ringbacks(h)[0].params).toMatchObject({ callControlId: call.callControlId, loop: "infinity" });
    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    expect(h.telnyx.calls.findIndex(entry => entry.method === "playbackStart"))
      .toBeLessThan(h.telnyx.calls.findIndex(entry => entry.method === "dial"));
    expect(h.openLegFor(call.sessionId, PROFILES.o1)?.to_number)
      .toBe(delivery === "personal mobile" ? "+421911222333" : "sip:gencred001@sip.telnyx.com");
    const before = h.telnyx.calls.length;

    const operator = await answer(h, call.sessionId);

    const commands = h.telnyx.calls.slice(before);
    const methods = commands.map(entry => entry.method);
    expect(methods.indexOf("bridge")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("playbackStop")).toBeGreaterThan(methods.indexOf("bridge"));
    expect(commands.filter(entry => entry.method === "playbackStop")).toHaveLength(1);
    expect(commands.filter(entry => entry.method === "playbackStart")).toHaveLength(0);
    expect(h.telnyx.physical.connected(call.callControlId, operator)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("keeps the same loop through the next ring step and external fallback, then stops before the callback prompt", async () => {
    const h = world({ fallbackKind: "external_number" });
    const call = await h.inbound();
    await rejectOpenOffers(h, call.sessionId);
    expect(h.legs(call.sessionId).some(leg => leg.to_number === NUMBERS.external && !leg.ended_at)).toBe(true);
    await rejectOpenOffers(h, call.sessionId);
    expect(sessionMeta(h, call.sessionId).ring?.fallback).toBe("external_number");
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(ringbacks(h)).toHaveLength(1);
    expect(h.telnyx.of("playbackStop")).toHaveLength(0);
    const before = h.telnyx.calls.length;

    await rejectOpenOffers(h, call.sessionId);

    expect(h.session(call.sessionId).state).toBe("callback_offered");
    const methods = h.telnyx.calls.slice(before).map(entry => entry.method);
    expect(methods.indexOf("playbackStop")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("playbackStop")).toBeLessThan(methods.indexOf("gatherUsingAudio"));
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params.audioUrl).toContain("callback-offer.mp3");
    expect(ringbacks(h)).toHaveLength(1);
  });

  it("stops ringback for the waiting-room prompt and does not restore it during a later queue offer", async () => {
    const h = world({ fallbackKind: "waiting_room" });
    const call = await h.inbound();
    await rejectOpenOffers(h, call.sessionId);
    const before = h.telnyx.calls.length;
    await rejectOpenOffers(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params.audioUrl).toContain("queueWaiting.mp3");
    const methods = h.telnyx.calls.slice(before).map(entry => entry.method);
    expect(methods.indexOf("playbackStop")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("playbackStop")).toBeLessThan(methods.indexOf("gatherUsingAudio"));

    h.advance(60_000);
    h.touchDevice(PROFILES.o1);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: h.telnyx.of("gatherUsingAudio").at(-1)!.params.clientState });

    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(sessionMeta(h, call.sessionId).queue).toBeTruthy();
    expect(h.openLegFor(call.sessionId, PROFILES.o1)).toBeTruthy();
    expect(ringbacks(h)).toHaveLength(1);
  });

  it.each(["waiting_room", "callback_prompt", "hangup_message"] as const)("never starts an unsent ringback when no operator is reachable and fallback is %s", async fallbackKind => {
    const h = world({ fallbackKind });
    h.db.delete("motorist_ring_group_members", row => row.member_kind === "external_number");
    for (const profileId of Object.values(PROFILES)) h.setPresence(profileId, { status: "offline" });

    const call = await h.inbound();

    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(ringbacks(h)).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe(fallbackKind === "waiting_room" ? "waiting" : fallbackKind === "callback_prompt" ? "callback_offered" : "missed");
    if (fallbackKind !== "hangup_message") expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(1);
  });

  it("keeps queue-first and manual pickup on queue audio without ringback", async () => {
    const h = world();
    h.db.update("motorist_telephony_settings", { inbound_call_mode: "queue_first" }, () => true);
    const call = await h.inbound();
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params.audioUrl).toContain("queueWaiting.mp3");

    const pickup = await pickupWaitingCall(h.deps, actor, call.sessionId);
    await h.legEvent(pickup.operatorLegCallControlId!, "call.answered");

    expect(h.session(call.sessionId).state).toBe("talking");
    expect(ringbacks(h)).toHaveLength(0);
  });

  it("stops ringback before placing an explicitly deferred call in the manual queue", async () => {
    const h = world();
    const call = await h.inbound();
    const before = h.telnyx.calls.length;
    await deferRingingCall(h.deps, actor, call.sessionId, String(h.openLegFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id));

    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(sessionMeta(h, call.sessionId).queue?.manual_only).toBe(true);
    const methods = h.telnyx.calls.slice(before).map(entry => entry.method);
    expect(methods.indexOf("playbackStop")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("playbackStop")).toBeLessThan(methods.indexOf("gatherUsingAudio"));
    expect(ringbacks(h)).toHaveLength(1);
  });

  it("replaces ringback with waiting music when the first bridge is refused", async () => {
    const h = world();
    const call = await h.inbound();
    h.telnyx.failNext("bridge", "bridge refused");
    const before = h.telnyx.calls.length;

    await answer(h, call.sessionId);

    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", answered_by_profile_id: null });
    expect(sessionMeta(h, call.sessionId).waiting?.reason).toBe("bridge_failed");
    const commands = h.telnyx.calls.slice(before);
    const methods = commands.map(entry => entry.method);
    expect(methods.indexOf("playbackStop")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("playbackStart")).toBeGreaterThan(methods.indexOf("playbackStop"));
    expect(commands.filter(entry => entry.method === "playbackStart")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ callControlId: call.callControlId, audioUrl: MUSIC, loop: "infinity" }) }),
    ]);
    expect(methods).toContain("gather");
    expect(ringbacks(h)).toHaveLength(1);
  });

  it.each(["missing media", "rejected playback"])("still rings and connects operators with %s", async failure => {
    const h = world(failure === "missing media" ? { mediaBaseUrl: null } : {});
    if (failure === "rejected playback") h.telnyx.failNext("playbackStart", "media unavailable");
    const call = await h.inbound();
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(3);

    await answer(h, call.sessionId);

    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("bridge")).toHaveLength(1);
  });

  it.each(["talking", "queued", "bridge_failed"])("ignores delayed ringback completion after the call is %s", async destination => {
    const h = world();
    const call = await h.inbound();
    const ringback = ringbacks(h)[0];
    if (destination === "bridge_failed") {
      h.telnyx.failNext("bridge", "bridge refused");
      await answer(h, call.sessionId);
      expect(h.telnyx.of("playbackStart").at(-1)?.params.audioUrl).toBe(MUSIC);
      expect(sessionMeta(h, call.sessionId).queue).toBeNull();
    } else if (destination === "talking") await answer(h, call.sessionId);
    else await deferRingingCall(h.deps, actor, call.sessionId, String(h.openLegFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id));
    const before = h.telnyx.calls.length;

    for (const status of ["completed", "cancelled", "file_not_found"]) {
      await h.legEvent(call.callControlId, "call.playback.ended", { status, client_state: ringback.params.clientState });
    }

    // Ownership recovery may re-send an unacknowledged loser
    // hangup; none of these stale audio events may start or stop playback.
    expect(h.telnyx.calls.slice(before).filter(entry => ["playbackStart", "playbackStop", "gather", "gatherUsingAudio", "gatherUsingSpeak"].includes(entry.method))).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe(destination === "talking" ? "talking" : "waiting");
  });

  it("does not create a playback retry loop when the provider cannot play ringback", async () => {
    const h = world();
    const call = await h.inbound();
    const ringback = ringbacks(h)[0];
    const dials = h.telnyx.of("dial").length;

    await h.legEvent(call.callControlId, "call.playback.ended", { status: "file_not_found", client_state: ringback.params.clientState });

    expect(ringbacks(h)).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("preserves the customer-gone marker before the exact hangup tears down the offers", async () => {
    const h = world();
    const call = await h.inbound();
    const ringback = ringbacks(h)[0];
    const offered = h.legs(call.sessionId).filter(leg => leg.role !== "customer").map(leg => leg.telnyx_call_control_id);

    await h.legEvent(call.callControlId, "call.playback.ended", { status: "call_hangup", client_state: ringback.params.clientState });

    expect(sessionMeta(h, call.sessionId).customer_gone_at).toBeTruthy();
    // The media completion records provider evidence; the correlated hangup
    // owns terminal state and teardown, as it did before ringback was added.
    expect(h.telnyx.of("hangup")).toHaveLength(0);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.telnyx.of("hangup").map(entry => entry.params.callControlId)).toEqual(expect.arrayContaining(offered));
    expect(h.telnyx.of("dial")).toHaveLength(offered.length);
    expect(ringbacks(h)).toHaveLength(1);
  });

  it("retains music for hold and park after the caller has connected", async () => {
    const h = world();
    const call = await h.inbound();
    await answer(h, call.sessionId);
    await holdCall(h.deps, actor, call.sessionId);
    expect(h.telnyx.of("conference:hold").at(-1)?.params.audio_url).toBe(MUSIC);
    await parkCall(h.deps, actor, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("parked");
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ audioUrl: MUSIC, loop: "infinity" });
    expect(ringbacks(h)).toHaveLength(1);
  });

  if (stable) it("retains the existing music through an unanswered controlled transfer", async () => {
    const h = world();
    const call = await h.inbound();
    await answer(h, call.sessionId);
    for (const leg of h.legs(call.sessionId).filter(row => row.role !== "customer" && row.profile_id !== PROFILES.o1 && !row.ended_at)) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
    }
    await blindTransfer(h.deps, actor, call.sessionId, { profileId: PROFILES.o2 });
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ audioUrl: MUSIC, loop: "infinity" });
    const before = h.telnyx.calls.length;
    await h.legEvent(String(h.openLegFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });

    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.telnyx.calls.slice(before).some(entry => entry.method === "playbackStart" || entry.method === "playbackStop")).toBe(false);
    expect(ringbacks(h)).toHaveLength(1);
  });
});
