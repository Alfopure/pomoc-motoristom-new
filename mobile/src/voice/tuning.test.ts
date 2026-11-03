import { describe, expect, it } from "vitest";
import { CACHED_TOKEN_MAX_AGE_MS, CACHED_TOKEN_MIN_LEFT_MS, parseVoiceTuning, realtimeTopic, usableCachedToken, VOICE_TUNING_OFF } from "./tuning";

const lease = "00000000-0000-4000-8000-000000000001", now = Date.parse("2026-11-02T10:00:00Z");
const expected = { profileId: "operator", deviceSessionId: lease, appBuild: "41", now };
const entry = (change: Record<string, unknown> = {}) => JSON.stringify({ v: 1, token: "keychain-jwt", expiresAt: new Date(now + 20 * 3_600_000).toISOString(),
  issuedAt: now - 3_600_000, deviceSessionId: lease, profileId: "operator", appBuild: "41", ...change });

describe("phone switches", () => {
  it("turns on only what the server explicitly turns on, key by key", () => {
    expect(parseVoiceTuning(undefined)).toEqual(VOICE_TUNING_OFF);
    expect(parseVoiceTuning({ mobileTokenCache: "true", mobileRtcRegion: "us", mobileTrickleIce: 1, futureSwitch: true })).toEqual(VOICE_TUNING_OFF);
    expect(parseVoiceTuning({ mobileTokenCache: true, mobileRtcRegion: "eu", mobileRealtimeStatus: true })).toEqual({ ...VOICE_TUNING_OFF,
      mobileTokenCache: true, mobileRtcRegion: "eu", mobileRealtimeStatus: true });
  });
  it("accepts only an organisation's private telephony topic", () => {
    expect(realtimeTopic("org:00000000-0000-4000-8000-0000000000aa:telephony")).toBe("org:00000000-0000-4000-8000-0000000000aa:telephony");
    for (const value of ["org:x:telephony", "org:00000000-0000-4000-8000-0000000000aa:sms", "realtime:public", null, 1]) expect(realtimeTopic(value)).toBeNull();
  });
});

describe("cached provider JWT", () => {
  it("is usable for its own operator, lease and build, from issue up to 12 h and until 15 min before expiry", () => {
    expect(usableCachedToken(entry(), expected)).toEqual({ token: JSON.parse(entry()) });
    expect(usableCachedToken(entry({ issuedAt: now - CACHED_TOKEN_MAX_AGE_MS, expiresAt: new Date(now + CACHED_TOKEN_MIN_LEFT_MS).toISOString() }), expected))
      .toHaveProperty("token");
  });
  it.each([
    [null, "none"], ["{", "malformed"], [entry({ v: 2 }), "malformed"], [entry({ token: "" }), "malformed"], [entry({ issuedAt: "yesterday" }), "malformed"],
    [entry({ profileId: "colleague" }), "profile"], [entry({ deviceSessionId: "00000000-0000-4000-8000-000000000002" }), "lease"],
    [entry({ appBuild: "40" }), "build"], [entry({ appBuild: null }), "build"],
    [entry({ expiresAt: new Date(now + CACHED_TOKEN_MIN_LEFT_MS - 1).toISOString() }), "expiring"],
    [entry({ issuedAt: now - CACHED_TOKEN_MAX_AGE_MS - 1 }), "age"], [entry({ issuedAt: now + 6 * 60_000 }), "age"],
  ])("refuses %s as %s", (raw, reason) => {
    expect(usableCachedToken(raw, expected)).toEqual({ reason });
  });
  it("refuses any cached JWT when this phone holds no lease", () => {
    expect(usableCachedToken(entry(), { ...expected, deviceSessionId: null })).toEqual({ reason: "lease" });
  });
});
