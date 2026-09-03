import { describe, expect, it } from "vitest";

import { getTelnyxConfig, telnyxLiveCallsAllowed, telnyxSmsAllowed, TELNYX_DEFAULT_API_BASE_URL } from "./env";

describe("getTelnyxConfig", () => {
  it("reports not configured without an API key and never throws", () => {
    expect(getTelnyxConfig({})).toEqual({ configured: false, reason: "TELNYX_API_KEY is not set" });
    expect(getTelnyxConfig({ TELNYX_API_KEY: "   " })).toMatchObject({ configured: false });
  });

  it("reads every value, trims it and applies defaults", () => {
    const config = getTelnyxConfig({
      TELNYX_API_KEY: " KEYtest ",
      TELNYX_API_BASE_URL: "https://api.telnyx.com/v2/",
      TELNYX_CALL_CONTROL_APP_ID: "123",
      TELNYX_MEDIA_BASE_URL: "https://example.test/telephony/",
    });

    expect(config).toMatchObject({
      configured: true,
      apiKey: "KEYtest",
      apiBaseUrl: "https://api.telnyx.com/v2",
      callControlAppId: "123",
      credentialConnectionId: null,
      smsAlphaSender: "PomocMotor",
      mediaBaseUrl: "https://example.test/telephony",
      liveCallsEnabled: false,
      smsLiveSendsEnabled: false,
    });
    expect(getTelnyxConfig({ TELNYX_API_KEY: "k" })).toMatchObject({ apiBaseUrl: TELNYX_DEFAULT_API_BASE_URL });
  });

  it("gates live actions on the explicit switches", () => {
    expect(telnyxLiveCallsAllowed({ TELNYX_API_KEY: "k" })).toBe(false);
    expect(telnyxLiveCallsAllowed({ TELNYX_API_KEY: "k", TELNYX_LIVE_CALLS_ENABLED: "true" })).toBe(true);
    expect(telnyxLiveCallsAllowed({ TELNYX_LIVE_CALLS_ENABLED: "true" })).toBe(false);
    expect(telnyxSmsAllowed({ TELNYX_API_KEY: "k", TELNYX_SMS_LIVE_SENDS: "TRUE" })).toBe(true);
    expect(telnyxSmsAllowed({ TELNYX_API_KEY: "k", TELNYX_SMS_LIVE_SENDS: "false" })).toBe(false);
  });
});
