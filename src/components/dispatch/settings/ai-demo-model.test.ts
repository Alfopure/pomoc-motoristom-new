import { describe, expect, it } from "vitest";

import type { AiDemoAttemptView, AiDemoPreflight } from "./ai-demo-client";
import {
  describeGaps, describeLatency, isActive, operatorBadge, readinessMessages, startErrorMessage,
  timelineSteps, validateContext, validateTarget, voiceLabel, voiceOptions,
} from "./ai-demo-model";

const READY: AiDemoPreflight = {
  enabled: true,
  configured: true,
  missing: [],
  fromNumber: "+421232408774",
  fromLineActive: true,
  recipientCount: 1,
  node: "v24.0.0",
  webSocketGlobal: true,
  deployedEnvironment: "development",
  telnyx: { configured: true, liveCallsEnv: true, liveCallsDb: true, destinationAllowlist: ["SK"], callControlAppId: "app-1" },
  db: { migrationApplied: true, activeAttempt: null, attemptsToday: 0 },
  limits: { maxAttemptsPerDay: 3, ringTimeoutSeconds: 30, maxCallSeconds: 300 },
  model: { live: "gpt-live-1", backend: "gpt-5.6-terra", voice: "gleam", sipHost: "sip.api.openai.com" },
  voices: { all: ["gleam", "willow", "marin", "quartz"], natural: ["gleam", "willow"] },
  probeBudgetMs: 18_000,
  remote: null,
};

function attempt(overrides: Partial<AiDemoAttemptView> = {}): AiDemoAttemptView {
  return {
    id: "a-1",
    state: "talking",
    scenario: "replacement_vehicle_return",
    greetingStatus: "heard_started",
    endReason: null,
    errorCode: null,
    targetMasked: "+421910•••882",
    fromNumber: "+421232408774",
    voice: "gleam",
    latency: null,
    timestamps: {
      requestedAt: "2026-09-03T08:00:00.000Z",
      sipDialedAt: "2026-09-03T08:00:01.000Z",
      aiOfferedAt: "2026-09-03T08:00:03.000Z",
      aiAcceptedAt: "2026-09-03T08:00:04.000Z",
      sipAnsweredAt: "2026-09-03T08:00:05.000Z",
      mobileDialedAt: "2026-09-03T08:00:05.000Z",
      mobileAnsweredAt: "2026-09-03T08:00:20.000Z",
      bridgedAt: "2026-09-03T08:00:20.000Z",
      greetingAppendedAt: "2026-09-03T08:00:21.000Z",
      firstTranscriptAt: "2026-09-03T08:00:22.000Z",
      endedAt: null,
    },
    ...overrides,
  };
}

describe("readinessMessages", () => {
  it("says it is ready, with the daily count, when everything is in place", () => {
    const messages = readinessMessages(READY);
    expect(messages).toHaveLength(1);
    expect(messages[0].tone).toBe("success");
    expect(messages[0].message).toContain("0/3");
  });

  it("names the missing environment variables verbatim", () => {
    const messages = readinessMessages({ ...READY, configured: false, missing: ["OPENAI_LIVE_PROJECT_ID"] });
    expect(messages.some((entry) => entry.message.includes("OPENAI_LIVE_PROJECT_ID"))).toBe(true);
  });

  it("offers the route to the kill switch rather than only naming it", () => {
    const messages = readinessMessages({ ...READY, telnyx: { ...READY.telnyx, liveCallsDb: false } });
    expect(messages.some((entry) => entry.action === "settings")).toBe(true);
  });

  it("warns that she cannot speak first without a WebSocket", () => {
    const messages = readinessMessages({ ...READY, webSocketGlobal: false });
    expect(messages.some((entry) => entry.message.includes("neozve"))).toBe(true);
  });

  it("reports an unapplied migration as blocking", () => {
    const messages = readinessMessages({ ...READY, db: { ...READY.db, migrationApplied: false } });
    expect(messages.some((entry) => entry.tone === "error")).toBe(true);
  });

  it("flags a DID attached to another Call Control application", () => {
    const messages = readinessMessages({
      ...READY,
      remote: { models: { liveAvailable: true, error: null }, did: { phoneNumber: "+421232408774", connectionId: "other", onThisApp: false, status: "active", error: null } },
    });
    expect(messages.some((entry) => entry.message.includes("inej Call Control"))).toBe(true);
  });
});

describe("operatorBadge", () => {
  it("reads the card the way an operator would", () => {
    expect(operatorBadge(READY)).toEqual({ tone: "ok", label: "Pripravená" });
    expect(operatorBadge({ ...READY, enabled: false }).tone).toBe("off");
    expect(operatorBadge({ ...READY, telnyx: { ...READY.telnyx, liveCallsDb: false } }).label).toBe("Živé hovory vypnuté");
    expect(operatorBadge({ ...READY, db: { ...READY.db, activeAttempt: attempt() } }).label).toBe("Telefonuje");
  });
});

describe("validateTarget", () => {
  it("accepts a Slovak national number and returns it in E.164", () => {
    expect(validateTarget("0910 988 882", READY)).toEqual({ ok: true, e164: "+421910988882" });
  });

  it("refuses our own line", () => {
    const result = validateTarget("+421232408774", READY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("vlastná linka");
  });

  it("refuses a destination outside the organisation allowlist", () => {
    const result = validateTarget("+15551234567", READY);
    expect(result.ok).toBe(false);
  });

  it("refuses text that is not a number", () => {
    expect(validateTarget("zavolaj Petrovi", READY).ok).toBe(false);
  });
});

describe("validateContext", () => {
  it("demands context only for the custom purpose", () => {
    expect(validateContext("replacement_vehicle_return", "")).toBeNull();
    expect(validateContext("custom", "krátke")).not.toBeNull();
    expect(validateContext("custom", "Volám kvôli faktúre za odťah")).toBeNull();
  });
});

describe("timelineSteps", () => {
  it("marks a step done once the call has moved past it, even without its timestamp", () => {
    const steps = timelineSteps(attempt({ timestamps: { ...attempt().timestamps, aiAcceptedAt: null } }));
    expect(steps.find((step) => step.key === "aiAcceptedAt")?.done).toBe(true);
  });

  it("highlights the stage the call is in", () => {
    const steps = timelineSteps(attempt({ state: "mobile_dialing" }));
    expect(steps.find((step) => step.current)?.key).toBe("mobileDialedAt");
  });
});

describe("latency labels", () => {
  it("states the number the demo is judged on", () => {
    expect(describeLatency(attempt({ latency: { first_word_ms: 1_800 } }))).toBe("prvé slovo 1.8 s po zdvihnutí");
    expect(describeLatency(attempt())).toBeNull();
  });

  it("averages the turn gaps and says how many there were", () => {
    expect(describeGaps(attempt({ latency: { response_gaps_ms: [900, 1_100] } }))).toBe("odozva 1.0 s (2×)");
    expect(describeGaps(attempt({ latency: { response_gaps_ms: [] } }))).toBeNull();
  });
});

describe("isActive", () => {
  it("treats only the terminal states as finished", () => {
    expect(isActive(attempt({ state: "ending" }))).toBe(true);
    expect(isActive(attempt({ state: "ended" }))).toBe(false);
    expect(isActive(attempt({ state: "failed" }))).toBe(false);
    expect(isActive(null)).toBe(false);
  });
});

describe("startErrorMessage", () => {
  it("translates the server codes into something an admin can act on", () => {
    expect(startErrorMessage("ai_demo_busy", "x")).toContain("už beží");
    expect(startErrorMessage("live_calls_disabled", "x")).toContain("Bezpečnosti");
    expect(startErrorMessage("ai_demo_recipient_not_allowed", "x")).toContain("povolených príjemcov");
    // An unknown code keeps the server's own message rather than inventing one.
    expect(startErrorMessage("something_new", "Serverová hláška")).toBe("Serverová hláška");
  });
});

describe("voiceOptions", () => {
  it("offers the recorded voices first, because those are the human-sounding ones", () => {
    const options = voiceOptions(READY);
    expect(options.slice(0, 2).map((o) => o.value)).toEqual(["gleam", "willow"]);
    expect(options.map((o) => o.value)).toContain("marin");
  });

  it("labels each voice so the choice is informed rather than a guess", () => {
    expect(voiceLabel("gleam")).toContain("nahrávaný");
    expect(voiceLabel("quartz")).toContain("syntetický");
    // An unknown id still renders rather than disappearing.
    expect(voiceLabel("brand-new-voice")).toBe("brand-new-voice");
  });
});
