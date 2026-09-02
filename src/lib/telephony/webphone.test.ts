import { describe, expect, it } from "vitest";

import {
  getViptelWebphoneConfig,
  getViptelWebphoneSession,
  isViptelWebphoneMockEnabled,
  isViptelWebphoneReadyForBrowser,
} from "./webphone";

describe("VIPTel webphone mock safety", () => {
  it("never enables the mock outside development", () => {
    expect(isViptelWebphoneMockEnabled({ NODE_ENV: "production", VIPTEL_WEBPHONE_MOCK_ENABLED: "true" })).toBe(false);
    expect(isViptelWebphoneMockEnabled({ NODE_ENV: "test", VIPTEL_WEBPHONE_MOCK_ENABLED: "true" })).toBe(false);
  });

  it("requires an explicit development-only flag", () => {
    expect(isViptelWebphoneMockEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(isViptelWebphoneMockEnabled({ NODE_ENV: "development", VIPTEL_WEBPHONE_MOCK_ENABLED: "true" })).toBe(true);
    expect(getViptelWebphoneConfig({ NODE_ENV: "development", VIPTEL_WEBPHONE_MOCK_ENABLED: "true" }).mockEnabled).toBe(true);
  });

  it("reports ready only when the selected extension can really receive a browser session", () => {
    const serverConfig = getViptelWebphoneConfig(readyEnvironment());
    const config = { ...serverConfig, credentialsExposure: "browser_test" as const };

    expect(config.status).toBe("ready");
    expect(config.credentialsExposure).toBe("browser_test");
    expect(isViptelWebphoneReadyForBrowser(config, "20")).toBe(true);
    expect(getViptelWebphoneSession(readyEnvironment(), "20")).toMatchObject({
      browserRegistrationAllowed: true,
      extension: { extension: "20", registrationEnabled: true },
    });
  });

  it("does not let one disabled extension block another operator's ready extension", () => {
    const env = readyEnvironment({
      VIPTEL_WEBPHONE_EXTENSIONS: "20,21",
      VIPTEL_WEBPHONE_21_PASSWORD: "test-password-21",
      VIPTEL_WEBPHONE_21_REGISTRATION_ENABLED: "false",
    });
    const serverConfig = getViptelWebphoneConfig(env);
    const config = { ...serverConfig, credentialsExposure: "browser_test" as const };

    expect(config.status).toBe("ready");
    expect(isViptelWebphoneReadyForBrowser(config, "20")).toBe(true);
    expect(isViptelWebphoneReadyForBrowser(config, "21")).toBe(false);
    expect(() => getViptelWebphoneSession(env, "21")).toThrow("nie je povolená");
  });

  it("keeps server configuration ready but withholds browser readiness when credential issuance is disabled", () => {
    const config = getViptelWebphoneConfig(readyEnvironment({
      VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS: "false",
    }));

    expect(config.status).toBe("ready");
    expect(config.credentialsExposure).toBe("redacted");
    expect(isViptelWebphoneReadyForBrowser(config, "20")).toBe(false);
  });

  it("does not issue credentials while the main webphone switch is disabled", () => {
    const env = readyEnvironment({ VIPTEL_SIP_WEBPHONE_ENABLED: "false" });

    expect(() => getViptelWebphoneSession(env, "20")).toThrow("je vypnuté");
  });
});

function readyEnvironment(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: "production",
    VIPTEL_SIP_BROWSER_REGISTRATION_ALLOWED: "true",
    VIPTEL_SIP_CODECS: "opus,PCMA",
    VIPTEL_SIP_DOMAIN: "sip.example.test",
    VIPTEL_SIP_DTMF_MODE: "rfc2833",
    VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS: "true",
    VIPTEL_SIP_REALM: "sip.example.test",
    VIPTEL_SIP_WEBPHONE_ENABLED: "true",
    VIPTEL_SIP_WS_URL: "wss://sip.example.test/ws",
    VIPTEL_WEBPHONE_20_AUTH_USERNAME: "operator-20",
    VIPTEL_WEBPHONE_20_PASSWORD: "test-password",
    VIPTEL_WEBPHONE_20_REGISTRATION_ENABLED: "true",
    VIPTEL_WEBPHONE_EXTENSIONS: "20",
    ...overrides,
  };
}
