import { describe, expect, it } from "vitest";

import { CLIENT_STATE_MAX_BYTES, decodeClientState } from "../telnyx/client-state";
import { AI_DEMO_INTENT_PREFIX, aiDemoLegOf } from "./flag";
import { aiDemoClientState, aiDemoCommandId, aiDemoCorrelationToken, maskNumber, parseAiDemoClientState, tokenFromHeader } from "./identity";

const ATTEMPT = "3f2b8c1a-5d4e-4a6b-8c9d-0e1f2a3b4c5d";

describe("aiDemoClientState", () => {
  it("round-trips through the Telnyx encoding", () => {
    for (const leg of ["sip", "mobile"] as const) {
      const encoded = aiDemoClientState(ATTEMPT, leg);
      expect(parseAiDemoClientState(encoded)).toEqual({ attemptId: ATTEMPT, leg });
    }
  });

  it("fits the 200-byte budget Telnyx echoes back", () => {
    expect(aiDemoClientState(ATTEMPT, "mobile").length).toBeLessThanOrEqual(CLIENT_STATE_MAX_BYTES);
  });

  it("uses leg roles the existing schema already accepts", () => {
    expect(decodeClientState(aiDemoClientState(ATTEMPT, "sip"))?.role).toBe("external");
    expect(decodeClientState(aiDemoClientState(ATTEMPT, "mobile"))?.role).toBe("customer");
  });

  it("agrees with the literal the webhook hot path uses", () => {
    // `event-processor.ts` duplicates this prefix to stay inside its module
    // budget; if the two ever diverge, demo webhooks silently take the human
    // path.
    expect(AI_DEMO_INTENT_PREFIX).toBe("ai_demo:");
    expect(decodeClientState(aiDemoClientState(ATTEMPT, "sip"))?.intent?.startsWith("ai_demo:")).toBe(true);
  });
});

describe("parseAiDemoClientState", () => {
  it("returns null for a human call leg", () => {
    const human = Buffer.from(JSON.stringify({ s: ATTEMPT, r: "operator", i: "ring" }), "utf8").toString("base64");
    expect(parseAiDemoClientState(human)).toBeNull();
  });

  it("returns null for absent, malformed or foreign values", () => {
    expect(parseAiDemoClientState(null)).toBeNull();
    expect(parseAiDemoClientState("not-base64!!")).toBeNull();
    expect(parseAiDemoClientState(Buffer.from('{"s":"x","r":"external","i":"ai_demo:sip"}').toString("base64"))).toBeNull();
  });

  it("returns null for an unknown leg name", () => {
    const forged = Buffer.from(JSON.stringify({ s: ATTEMPT, r: "external", i: "ai_demo:admin" }), "utf8").toString("base64");
    expect(parseAiDemoClientState(forged)).toBeNull();
  });
});

describe("aiDemoLegOf", () => {
  it("recognises only the two legs of the demo", () => {
    expect(aiDemoLegOf("ai_demo:sip")).toBe("sip");
    expect(aiDemoLegOf("ai_demo:mobile")).toBe("mobile");
    expect(aiDemoLegOf("ai_demo:other")).toBeNull();
    expect(aiDemoLegOf("ring")).toBeNull();
    expect(aiDemoLegOf(undefined)).toBeNull();
  });
});

describe("aiDemoCommandId", () => {
  it("is deterministic, so a redelivered webhook cannot dial twice", () => {
    expect(aiDemoCommandId(ATTEMPT, "sip", "dial")).toBe(aiDemoCommandId(ATTEMPT, "sip", "dial"));
  });

  it("differs per leg and per intent", () => {
    const ids = new Set([
      aiDemoCommandId(ATTEMPT, "sip", "dial"),
      aiDemoCommandId(ATTEMPT, "mobile", "dial"),
      aiDemoCommandId(ATTEMPT, "sip", "hangup"),
      aiDemoCommandId(ATTEMPT, "mobile", "hangup"),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe("aiDemoCorrelationToken", () => {
  it("is derived from the attempt and readable in a SIP From header", () => {
    const token = aiDemoCorrelationToken(ATTEMPT);
    expect(token).toBe("PM-AI-DEMO-3f2b8c1a");
    expect(tokenFromHeader(`"${token}" <sip:+421232408774@example.test>`)).toBe(token);
  });

  it("finds nothing in a header that carries no token", () => {
    expect(tokenFromHeader("<sip:anonymous@example.test>")).toBeNull();
    expect(tokenFromHeader(null)).toBeNull();
  });
});

describe("maskNumber", () => {
  it("keeps the country and the last three digits only", () => {
    expect(maskNumber("+421910988882")).toBe("+421910•••882");
    expect(maskNumber(null)).toBeNull();
    expect(maskNumber("+421")).toBeNull();
  });
});
