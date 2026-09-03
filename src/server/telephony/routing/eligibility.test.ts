import { describe, expect, it } from "vitest";

import { classifyRingHangup, DEVICE_LIVENESS_WINDOW_MS, evaluateMemberEligibility, isDeviceLive, isTerminalAttempt, presenceAllowsOffer } from "./eligibility";

const NOW = new Date("2026-09-03T10:00:00.000Z");
const seenAt = (agoMs: number) => new Date(NOW.getTime() - agoMs).toISOString();

const baseDevice = { profileId: "p1", sipUsername: "gencred1", deviceSeenAt: seenAt(10_000), registrationState: "registered" };

function input(overrides: Partial<Parameters<typeof evaluateMemberEligibility>[1]> = {}) {
  return {
    now: NOW,
    presence: [{ profileId: "p1", status: "available" as const }],
    devices: [baseDevice],
    openOffers: [],
    sessionId: "s1",
    ...overrides,
  };
}

describe("evaluateMemberEligibility", () => {
  it("always accepts external numbers", () => {
    expect(evaluateMemberEligibility({ kind: "external_number", externalNumber: "+421910988882" }, input({ presence: [], devices: [] }))).toEqual({ eligible: true });
  });

  it("accepts an available operator with a live device and no open offer", () => {
    expect(evaluateMemberEligibility({ kind: "operator", profileId: "p1" }, input())).toEqual({ eligible: true });
  });

  it("rejects offline, paused, on_call and ringing-elsewhere operators", () => {
    for (const [status, reason] of [
      ["offline", "offline"],
      ["paused", "paused"],
      ["on_call", "on_call"],
      ["ringing", "ringing"],
    ] as const) {
      expect(evaluateMemberEligibility({ kind: "operator", profileId: "p1" }, input({ presence: [{ profileId: "p1", status, currentSessionId: "other" }] }))).toEqual({ eligible: false, reason });
    }
    expect(evaluateMemberEligibility({ kind: "operator", profileId: "p1" }, input({ presence: [] }))).toEqual({ eligible: false, reason: "no_presence" });
  });

  it("lets a ringing operator be re-evaluated for the same session", () => {
    expect(evaluateMemberEligibility({ kind: "operator", profileId: "p1" }, input({ presence: [{ profileId: "p1", status: "ringing", currentSessionId: "s1" }] }))).toEqual({ eligible: true });
  });

  it("accepts after_call_work only once wrap_up_until has passed", () => {
    const future = new Date(NOW.getTime() + 5_000).toISOString();
    const past = new Date(NOW.getTime() - 1).toISOString();
    expect(presenceAllowsOffer({ profileId: "p1", status: "after_call_work", wrapUpUntil: future }, NOW)).toEqual({ eligible: false, reason: "wrap_up" });
    expect(presenceAllowsOffer({ profileId: "p1", status: "after_call_work", wrapUpUntil: past }, NOW)).toEqual({ eligible: true });
    expect(presenceAllowsOffer({ profileId: "p1", status: "after_call_work", wrapUpUntil: null }, NOW)).toEqual({ eligible: true });
  });

  it("requires a device seen within 120 s", () => {
    expect(isDeviceLive({ ...baseDevice, deviceSeenAt: seenAt(DEVICE_LIVENESS_WINDOW_MS) }, NOW)).toBe(true);
    expect(isDeviceLive({ ...baseDevice, deviceSeenAt: seenAt(DEVICE_LIVENESS_WINDOW_MS + 1) }, NOW)).toBe(false);
    expect(isDeviceLive({ ...baseDevice, registrationState: "error" }, NOW)).toBe(false);
    expect(evaluateMemberEligibility({ kind: "operator", profileId: "p1" }, input({ devices: [{ ...baseDevice, deviceSeenAt: seenAt(200_000) }] }))).toEqual({ eligible: false, reason: "device_stale" });
    expect(evaluateMemberEligibility({ kind: "operator", profileId: "p1" }, input({ devices: [] }))).toEqual({ eligible: false, reason: "no_device" });
    expect(evaluateMemberEligibility({ kind: "operator", profileId: "p1" }, input({ devices: [{ ...baseDevice, sipUsername: null }] }))).toEqual({ eligible: false, reason: "no_device" });
  });

  it("rejects an operator with an open offer in another session", () => {
    expect(evaluateMemberEligibility({ kind: "operator", profileId: "p1" }, input({ openOffers: ["p1"] }))).toEqual({ eligible: false, reason: "open_offer" });
    expect(evaluateMemberEligibility({ kind: "operator", profileId: "p1" }, input({ openOffers: new Set(["p2"]) }))).toEqual({ eligible: true });
  });
});

describe("classifyRingHangup", () => {
  it("maps Telnyx hangup causes to attempt results", () => {
    expect(classifyRingHangup({ hangupCause: "not_found", sipHangupCause: "480" })).toBe("skipped_offline");
    expect(classifyRingHangup({ hangupCause: "USER_NOT_REGISTERED" })).toBe("skipped_offline");
    expect(classifyRingHangup({ hangupCause: "unspecified", sipHangupCause: "404" })).toBe("skipped_offline");
    expect(classifyRingHangup({ hangupCause: "user_busy" })).toBe("busy");
    expect(classifyRingHangup({ hangupCause: "unspecified", sipHangupCause: 486 })).toBe("busy");
    expect(classifyRingHangup({ hangupCause: "timeout" })).toBe("no_answer");
    expect(classifyRingHangup({ hangupCause: "no_answer" })).toBe("no_answer");
    expect(classifyRingHangup({ hangupCause: "call_rejected" })).toBe("no_answer");
    expect(classifyRingHangup({ hangupCause: "originator_cancel" })).toBe("cancelled");
    expect(classifyRingHangup({ hangupCause: "unspecified", sipHangupCause: "487" })).toBe("cancelled");
    expect(classifyRingHangup({ hangupCause: "unspecified" })).toBe("failed");
    expect(classifyRingHangup({ hangupCause: null })).toBe("no_answer");
    expect(classifyRingHangup({ hangupCause: "normal_clearing", answered: true })).toBe("answered");
  });

  it("knows which results are terminal", () => {
    expect(isTerminalAttempt("offered")).toBe(false);
    expect(isTerminalAttempt("pending")).toBe(false);
    expect(isTerminalAttempt("no_answer")).toBe(true);
    expect(isTerminalAttempt("answered")).toBe(true);
  });
});
