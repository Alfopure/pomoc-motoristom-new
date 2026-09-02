import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIPTEL_ROTATION_SECONDS,
  dispatchCoverageWindowSeconds,
  parseViptelRotationSettings,
  validateFallbackAgainstRotation,
} from "./dispatch-rotation";

const at = (periodSeconds: number, finalQueueLoops = false) =>
  parseViptelRotationSettings({ inboundRotation: { periodSeconds, finalQueueLoops } });

describe("rotation settings", () => {
  it("defaults to the confirmed provider setting of 30 seconds", () => {
    expect(parseViptelRotationSettings({}).periodSeconds).toBe(DEFAULT_VIPTEL_ROTATION_SECONDS);
    expect(DEFAULT_VIPTEL_ROTATION_SECONDS).toBe(30);
  });

  it("falls back to the default rather than trusting an out-of-range value", () => {
    for (const bad of [0, -5, 4, 10_000, "thirty", null]) {
      expect(parseViptelRotationSettings({ inboundRotation: { periodSeconds: bad } }).periodSeconds)
        .toBe(DEFAULT_VIPTEL_ROTATION_SECONDS);
    }
  });

  it("derives the coverage window from queue count times period, not a literal", () => {
    expect(dispatchCoverageWindowSeconds(at(30))).toBe(90);
    expect(dispatchCoverageWindowSeconds(at(20))).toBe(60);
    // A looping final queue has no bounded window.
    expect(dispatchCoverageWindowSeconds(at(30, true))).toBeNull();
  });
});

describe("fallback delay against rotation", () => {
  it("accepts the current production pairing of 60s fallback with 30s rotation", () => {
    expect(validateFallbackAgainstRotation(60, at(30)).level).toBe("ok");
  });

  it("still accepts 60s once rotation moves to 20s, where it exactly covers the window", () => {
    expect(validateFallbackAgainstRotation(60, at(20)).level).toBe("ok");
  });

  it("rejects a fallback shorter than one rotation step", () => {
    // The caller would be redirected before the first workstation stopped ringing.
    const verdict = validateFallbackAgainstRotation(10, at(30));
    expect(verdict.level).toBe("invalid");
  });

  it("only advises, never blocks, when the fallback outlasts the rotation", () => {
    // This setting records provider-owned behaviour and can be stale, so only
    // the unambiguous case is fatal.
    expect(validateFallbackAgainstRotation(300, at(30)).level).toBe("advisory");
    expect(validateFallbackAgainstRotation(45, at(30)).level).toBe("advisory");
  });
});
