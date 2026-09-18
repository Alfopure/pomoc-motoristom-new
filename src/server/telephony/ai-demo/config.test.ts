import { describe, expect, it } from "vitest";

import {
  AI_DEMO_NATURAL_VOICES, AI_DEMO_NEUTRAL_LINE, aiDemoBudgets, aiDemoEnabled, aiDemoFromNumber, aiDemoWebhookUrl, buildSipUri, getAiDemoConfig, parseRecipients,
} from "./config";

const FULL = {
  AI_DEMO_ENABLED: "true",
  AI_DEMO_ALLOWED_RECIPIENTS: "0910 988 882",
  OPENAI_API_KEY: "sk-proj-real-key",
  OPENAI_LIVE_PROJECT_ID: "proj_abc123",
  OPENAI_WEBHOOK_SECRET: "whsec_c2VjcmV0",
};

describe("aiDemoEnabled", () => {
  it("is off unless the value is exactly true", () => {
    expect(aiDemoEnabled({})).toBe(false);
    expect(aiDemoEnabled({ AI_DEMO_ENABLED: "1" })).toBe(false);
    expect(aiDemoEnabled({ AI_DEMO_ENABLED: "yes" })).toBe(false);
    expect(aiDemoEnabled({ AI_DEMO_ENABLED: "TRUE" })).toBe(true);
  });
});

describe("getAiDemoConfig", () => {
  it("names every missing variable instead of failing with one message", () => {
    const config = getAiDemoConfig({});
    expect(config.configured).toBe(false);
    if (config.configured) return;
    expect(config.missing).toEqual(["OPENAI_API_KEY", "OPENAI_LIVE_PROJECT_ID", "OPENAI_WEBHOOK_SECRET"]);
  });

  it("does not accept the .env.example placeholder as a key", () => {
    const config = getAiDemoConfig({ ...FULL, OPENAI_API_KEY: "your-openai-api-key" });
    expect(config.configured).toBe(false);
    if (!config.configured) expect(config.missing).toContain("OPENAI_API_KEY");
  });

  it("requires a project id in the documented shape", () => {
    const config = getAiDemoConfig({ ...FULL, OPENAI_LIVE_PROJECT_ID: "abc123" });
    if (!config.configured) expect(config.missing).toContain("OPENAI_LIVE_PROJECT_ID");
    else expect.unreachable("a project id without the proj_ prefix must be refused");
  });

  it("treats an unset recipient shortlist as no extra restriction", () => {
    // The organisation's own destination allowlist still applies; this list is
    // an optional second, tighter gate.
    const config = getAiDemoConfig({ ...FULL, AI_DEMO_ALLOWED_RECIPIENTS: "" });
    expect(config.configured).toBe(true);
    if (config.configured) expect(config.allowedRecipients).toEqual([]);
  });

  it("normalises the recipients so a national spelling still matches", () => {
    const config = getAiDemoConfig({ ...FULL, AI_DEMO_ALLOWED_RECIPIENTS: "0910 988 882, +421 903 111 222" });
    expect(config.configured).toBe(true);
    if (config.configured) expect(config.allowedRecipients).toEqual(["+421910988882", "+421903111222"]);
  });

  it("defaults the model, the voice and the SIP host", () => {
    const config = getAiDemoConfig(FULL);
    expect(config.configured).toBe(true);
    if (!config.configured) return;
    expect(config.model).toBe("gpt-live-1");
    expect(config.backendModel).toBe("gpt-5.6-terra");
    // A voice the documentation marks as recorded rather than synthesised;
    // `marin` is the API default and sounded synthetic on the first live call.
    expect(config.voice).toBe("gleam");
    expect(AI_DEMO_NATURAL_VOICES).toContain(config.voice);
    // `sip-eu` needs an EU data-residency project; both hosts are GeoIP-routed.
    expect(config.sipHost).toBe("sip.api.openai.com");
  });

  it("refuses a model, voice or host outside the allowlist", () => {
    for (const [key, value] of [
      ["OPENAI_LIVE_MODEL", "gpt-4o-realtime"],
      ["OPENAI_LIVE_VOICE", "veronika"],
      ["OPENAI_LIVE_SIP_HOST", "sip.attacker.test"],
      ["OPENAI_LIVE_BACKEND_MODEL", "gpt-3.5"],
    ] as const) {
      const config = getAiDemoConfig({ ...FULL, [key]: value });
      if (!config.configured) expect(config.missing, `${key}=${value}`).toContain(key);
      else expect.unreachable(`${key} must be allowlisted`);
    }
  });

  it("clamps the limits to their documented ranges", () => {
    const config = getAiDemoConfig({ ...FULL, AI_DEMO_MAX_CALL_SECONDS: "9000", AI_DEMO_RING_TIMEOUT_SECONDS: "1", AI_DEMO_MAX_ATTEMPTS_PER_DAY: "999" });
    expect(config.configured).toBe(true);
    if (!config.configured) return;
    expect(config.maxCallSeconds).toBe(300);
    expect(config.ringTimeoutSeconds).toBe(5);
    expect(config.maxAttemptsPerDay).toBe(100);
  });

  it("derives every other budget from the one call-length value", () => {
    const config = getAiDemoConfig({ ...FULL, AI_DEMO_MAX_CALL_SECONDS: "120", AI_DEMO_RING_TIMEOUT_SECONDS: "20" });
    expect(config.configured).toBe(true);
    if (!config.configured) return;
    const budgets = aiDemoBudgets(config);
    // The SIP leg has to outlive the mobile leg, or the backstop fires first.
    expect(budgets.sipTimeLimitSeconds).toBeGreaterThan(budgets.mobileTimeLimitSeconds);
    expect(budgets.attemptDeadlineSeconds).toBeGreaterThan(budgets.sipTimeLimitSeconds);
    expect(budgets.staleTalkingSeconds).toBeGreaterThan(budgets.mobileTimeLimitSeconds);
  });
});

describe("aiDemoFromNumber", () => {
  it("defaults to the neutral line", () => {
    expect(aiDemoFromNumber({})).toEqual({ number: AI_DEMO_NEUTRAL_LINE });
  });

  it("refuses the line that cannot originate, in both spellings Telnyx stores", () => {
    expect(aiDemoFromNumber({ AI_DEMO_FROM_NUMBER: "+421232408700" })).toEqual({ invalid: "+421232408700" });
    expect(aiDemoFromNumber({ AI_DEMO_FROM_NUMBER: "+4210232408700" })).toEqual({ invalid: "+421232408700" });
  });

  it("refuses a caller ID outside the allowlist", () => {
    expect(aiDemoFromNumber({ AI_DEMO_FROM_NUMBER: "+421910988882" })).toEqual({ invalid: "+421910988882" });
  });

  it("accepts the partner line only when it is set explicitly", () => {
    expect(aiDemoFromNumber({ AI_DEMO_FROM_NUMBER: "+421232408718" })).toEqual({ number: "+421232408718" });
  });
});

describe("buildSipUri", () => {
  it("builds the documented OpenAI SIP target", () => {
    expect(buildSipUri("proj_abc123", "sip.api.openai.com")).toBe("sip:proj_abc123@sip.api.openai.com;transport=tls");
  });
});

describe("parseRecipients", () => {
  it("drops entries that are not phone numbers rather than guessing", () => {
    expect(parseRecipients("0910988882, not-a-number, 123")).toEqual(["+421910988882"]);
    expect(parseRecipients("nonsense")).toBeNull();
  });
});

describe("aiDemoWebhookUrl", () => {
  it("is absent unless a base URL is configured", () => {
    expect(aiDemoWebhookUrl({})).toBeNull();
  });

  it("builds the Telnyx webhook path from the deployment's own origin", () => {
    expect(aiDemoWebhookUrl({ AI_DEMO_WEBHOOK_BASE_URL: "https://demo.example.test" }))
      .toBe("https://demo.example.test/api/telephony/telnyx/webhook");
    // A path or query on the base must not end up in the callback URL.
    expect(aiDemoWebhookUrl({ AI_DEMO_WEBHOOK_BASE_URL: "https://demo.example.test/anything?x=1" }))
      .toBe("https://demo.example.test/api/telephony/telnyx/webhook");
  });

  it("refuses anything that is not HTTPS", () => {
    expect(aiDemoWebhookUrl({ AI_DEMO_WEBHOOK_BASE_URL: "http://demo.example.test" })).toBeNull();
    expect(aiDemoWebhookUrl({ AI_DEMO_WEBHOOK_BASE_URL: "not a url" })).toBeNull();
  });
});

describe("the daily cap", () => {
  it("treats 0 as no cap rather than as a cap of nothing", () => {
    const config = getAiDemoConfig({ ...FULL, AI_DEMO_MAX_ATTEMPTS_PER_DAY: "0" });
    expect(config.configured).toBe(true);
    if (config.configured) expect(config.maxAttemptsPerDay).toBe(0);
  });

  it("still refuses a value it cannot make sense of", () => {
    const config = getAiDemoConfig({ ...FULL, AI_DEMO_MAX_ATTEMPTS_PER_DAY: "nonsense" });
    if (config.configured) expect(config.maxAttemptsPerDay).toBe(3);
  });
});

describe("the review model", () => {
  it("is chosen separately from the in-call backend", () => {
    // Different jobs: one must not make anybody wait on a telephone, the other
    // runs afterwards and only has to read well.
    const config = getAiDemoConfig({ ...FULL, OPENAI_LIVE_BACKEND_MODEL: "gpt-5.6-luna", OPENAI_LIVE_REVIEW_MODEL: "gpt-5.6-sol" });
    expect(config.configured).toBe(true);
    if (!config.configured) return;
    expect(config.backendModel).toBe("gpt-5.6-luna");
    expect(config.reviewModel).toBe("gpt-5.6-sol");
  });

  it("may be stronger than anything allowed in the call", () => {
    const config = getAiDemoConfig({ ...FULL, OPENAI_LIVE_REVIEW_MODEL: "gpt-6-astra" });
    if (config.configured) expect(config.reviewModel).toBe("gpt-6-astra");
    else expect.unreachable("a stronger reviewer must be allowed");
  });

  it("refuses one outside the allowlist", () => {
    const config = getAiDemoConfig({ ...FULL, OPENAI_LIVE_REVIEW_MODEL: "gpt-4o" });
    if (!config.configured) expect(config.missing).toContain("OPENAI_LIVE_REVIEW_MODEL");
    else expect.unreachable("review models must be allowlisted too");
  });
});
