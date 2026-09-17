import { beforeEach, describe, expect, it } from "vitest";

import { createFakeOpenAIFetch } from "@/test/fake-openai-live";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import type { TelephonyEvent } from "../state/types";
import { loadAttempt, transitionAttempt, type AiDemoAttempt } from "./attempts";
import { AI_DEMO_NEUTRAL_LINE } from "./config";
import { aiDemoClientState } from "./identity";
import { startAiDemo, type AiDemoDeps } from "./orchestrator";
import { describeHangup, handleAiDemoTelnyxEvent, isAiDemoEvent } from "./telnyx-events";

const ENV = {
  AI_DEMO_ENABLED: "true",
  AI_DEMO_ALLOWED_RECIPIENTS: "+421910988882",
  OPENAI_API_KEY: "sk-proj-test",
  OPENAI_LIVE_PROJECT_ID: "proj_test123",
  OPENAI_WEBHOOK_SECRET: "whsec_c2VjcmV0",
};

const FAST_PROBE = { probeOpenMs: 50, probeAppendedMs: 50, probeFirstDeltaMs: 80, probeWindowMs: 120, probeMaxEvents: 40 };

type Fixture = { h: TelephonyHarness; deps: AiDemoDeps; attempt: AiDemoAttempt };

async function fixture(): Promise<Fixture> {
  const h = createTelephonyHarness();
  h.db.seed("motorist_telephony_lines", [
    {
      id: "00000000-0000-4000-8000-000000000208", organization_id: ORG, provider: "telnyx", phone_number: AI_DEMO_NEUTRAL_LINE,
      label: "Neutrálna linka 2", partner_name: null, ring_plan_id: null, ivr_menu_id: null, business_hours_id: null,
      environment: "production", active: true, telnyx_number_id: "3043592669122004035", external_id: null, metadata: {},
    },
  ]);
  const openai = createFakeOpenAIFetch();
  const deps: AiDemoDeps = {
    ...h.deps,
    env: ENV,
    openAIFetch: openai.fetch,
    telnyxClientFactory: () => h.telnyx.client,
    probeLimits: FAST_PROBE,
    // A WebSocket that refuses to open keeps the greeting probe out of the way
    // of the event-ordering assertions; `greeting.test.ts` covers the probe.
    webSocketFactory: () => {
      throw new Error("sideband_disabled_in_test");
    },
  };
  const { attempt } = await startAiDemo(deps, { actorProfileId: PROFILES.o5, requestId: null, to: "+421910988882" });
  return { h, deps, attempt };
}

function event(overrides: Partial<TelephonyEvent> & { type: string; leg: "sip" | "mobile"; attemptId: string }): TelephonyEvent {
  const { leg, attemptId, ...rest } = overrides;
  return {
    kind: "telnyx",
    id: `evt-${Math.random().toString(16).slice(2)}`,
    occurredAt: null,
    callControlId: leg === "sip" ? "cc-sip" : "cc-mobile",
    callLegId: leg === "sip" ? "leg-sip" : "leg-mobile",
    callSessionId: "telnyx-session-1",
    connectionId: "app-test",
    clientState: null,
    rawClientState: aiDemoClientState(attemptId, leg),
    from: AI_DEMO_NEUTRAL_LINE,
    to: "+421910988882",
    direction: "outgoing",
    state: null,
    hangupCause: null,
    hangupSource: null,
    sipHangupCause: null,
    digits: null,
    status: null,
    conferenceId: null,
    customHeaders: [],
    payload: {},
    ...rest,
  } as TelephonyEvent;
}

/** Drives the attempt to the state the event under test expects. */
async function toState(f: Fixture, patch: Record<string, unknown>) {
  await transitionAttempt(f.deps.admin, f.attempt.id, ["requested", "sip_dialing", "ai_offered", "ai_accepted", "mobile_dialing", "bridged"], patch);
}

describe("isAiDemoEvent", () => {
  it("recognises our legs and nothing else", async () => {
    const f = await fixture();
    expect(isAiDemoEvent(event({ type: "call.answered", leg: "sip", attemptId: f.attempt.id }))).toBe(true);
    expect(isAiDemoEvent(event({ type: "call.answered", leg: "sip", attemptId: f.attempt.id, rawClientState: null }))).toBe(false);
  });
});

describe("the SIP leg", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it("records the call_control_id from call.initiated, before any dial response", async () => {
    await handleAiDemoTelnyxEvent(f.deps, event({ type: "call.initiated", leg: "sip", attemptId: f.attempt.id }));
    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.telnyx_sip_call_control_id).toBe("cc-sip");
    expect(row?.sip_initiated_at).not.toBeNull();
  });

  it("dials the customer only once the AI leg has answered", async () => {
    await toState(f, { state: "ai_accepted", openai_session_id: "live_x", telnyx_sip_call_control_id: "cc-sip" });

    await handleAiDemoTelnyxEvent(f.deps, event({ type: "call.answered", leg: "sip", attemptId: f.attempt.id }));

    const mobileDials = f.h.telnyx.of("dial").filter((call) => call.params.to === "+421910988882");
    expect(mobileDials).toHaveLength(1);
    // `link_to` alone only shares a session; without `bridge_on_answer` the
    // customer would hear silence.
    expect(mobileDials[0].params.linkTo).toBe("cc-sip");
    expect(mobileDials[0].params.bridgeOnAnswer).toBe(true);
    expect(mobileDials[0].params.preventDoubleBridge).toBe(true);
    expect(mobileDials[0].params.mediaEncryption).toBeUndefined();
    expect((await loadAttempt(f.deps.admin, ORG, f.attempt.id))?.state).toBe("mobile_dialing");
  });

  it("does not dial twice when the answer is delivered twice", async () => {
    await toState(f, { state: "ai_accepted", openai_session_id: "live_x", telnyx_sip_call_control_id: "cc-sip" });
    const answered = event({ type: "call.answered", leg: "sip", attemptId: f.attempt.id });

    await handleAiDemoTelnyxEvent(f.deps, answered);
    await handleAiDemoTelnyxEvent(f.deps, answered);

    expect(f.h.telnyx.of("dial").filter((call) => call.params.to === "+421910988882")).toHaveLength(1);
  });

  it("ends the demo when the AI leg dies before the bridge", async () => {
    await toState(f, { state: "ai_accepted", telnyx_sip_call_control_id: "cc-sip" });

    await handleAiDemoTelnyxEvent(f.deps, event({ type: "call.hangup", leg: "sip", attemptId: f.attempt.id, hangupCause: "call_rejected" }));

    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.state).toBe("failed");
    expect(row?.error_code).toBe("sip_ended_early");
  });

  it("treats a replayed answer as a reason to end, not to dial", async () => {
    await toState(f, { state: "ai_accepted", telnyx_sip_call_control_id: "cc-sip" });

    await handleAiDemoTelnyxEvent({ ...f.deps, ledgerReplay: "cron" }, event({ type: "call.answered", leg: "sip", attemptId: f.attempt.id }));

    expect(f.h.telnyx.of("dial").filter((call) => call.params.to === "+421910988882")).toHaveLength(0);
    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.end_reason).toBe("replayed_answer");
  });
});

describe("the customer leg", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
    await toState(f, { state: "mobile_dialing", openai_session_id: "live_x", telnyx_sip_call_control_id: "cc-sip", mobile_dialed_at: f.h.now().toISOString() });
  });

  it("bridges and asks for the greeting when the phone is answered", async () => {
    await handleAiDemoTelnyxEvent(f.deps, event({ type: "call.answered", leg: "mobile", attemptId: f.attempt.id }));

    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    // The probe runs inline here (no `deferMaintenance`) and fails by design,
    // so the row lands on `talking` with a failed greeting rather than stalling.
    expect(["bridged", "talking"]).toContain(row?.state);
    expect(row?.bridged_at).not.toBeNull();
  });

  it("accepts call.bridged arriving before call.answered", async () => {
    await handleAiDemoTelnyxEvent(f.deps, event({ type: "call.bridged", leg: "mobile", attemptId: f.attempt.id }));
    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.bridged_at).not.toBeNull();
  });

  it("greets once when both call.answered and call.bridged arrive", async () => {
    const calls: Array<() => Promise<void>> = [];
    const deps: AiDemoDeps = { ...f.deps, deferMaintenance: (work) => void calls.push(work) };

    await handleAiDemoTelnyxEvent(deps, event({ type: "call.answered", leg: "mobile", attemptId: f.attempt.id }));
    await handleAiDemoTelnyxEvent(deps, event({ type: "call.bridged", leg: "mobile", attemptId: f.attempt.id }));

    expect(calls).toHaveLength(1);
  });

  it("closes the demo normally when the customer hangs up", async () => {
    await transitionAttempt(f.deps.admin, f.attempt.id, ["mobile_dialing"], { state: "talking", bridged_at: f.h.now().toISOString(), telnyx_mobile_call_control_id: "cc-mobile" });

    await handleAiDemoTelnyxEvent(f.deps, event({ type: "call.hangup", leg: "mobile", attemptId: f.attempt.id, hangupCause: "normal_clearing", hangupSource: "callee" }));

    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.state).toBe("ended");
    expect(row?.error_code).toBeNull();
    expect(row?.end_reason).toBe("mobile_normal_clearing");
    expect(row?.hangup_source).toBe("callee");
  });

  it("treats an unanswered phone as an outcome, not a fault", async () => {
    await handleAiDemoTelnyxEvent(f.deps, event({ type: "call.hangup", leg: "mobile", attemptId: f.attempt.id, hangupCause: "no_answer" }));
    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.state).toBe("ended");
    expect(row?.end_reason).toBe("mobile_no_answer");
  });

  it("skips the greeting for a replayed answer instead of speaking into a finished call", async () => {
    await handleAiDemoTelnyxEvent({ ...f.deps, ledgerReplay: "cron" }, event({ type: "call.answered", leg: "mobile", attemptId: f.attempt.id }));
    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.greeting_status).toBe("skipped_replay");
  });
});

describe("unknown attempts", () => {
  it("ignores an event whose attempt does not exist", async () => {
    const f = await fixture();
    const outcome = await handleAiDemoTelnyxEvent(f.deps, event({ type: "call.answered", leg: "sip", attemptId: "99999999-9999-4999-8999-999999999999" }));
    expect(outcome).toEqual({ handled: false, reason: "unknown_attempt" });
  });
});

describe("describeHangup", () => {
  it("separates a completed conversation from a demo that never connected", () => {
    expect(describeHangup("talking", "sip", "normal_clearing")).toEqual({ endReason: "normal_clearing", errorCode: null });
    expect(describeHangup("ai_accepted", "sip", "call_rejected")).toEqual({ endReason: "call_rejected", errorCode: "sip_ended_early" });
  });

  it("reads a refused SIP dial as a rejection and a silent one as no answer", () => {
    expect(describeHangup("sip_dialing", "sip", "call_rejected")).toEqual({ endReason: "call_rejected", errorCode: "sip_rejected" });
    expect(describeHangup("sip_dialing", "sip", "timeout")).toEqual({ endReason: "timeout", errorCode: "sip_no_answer" });
  });

  it("never blames the customer's phone", () => {
    for (const cause of ["no_answer", "user_busy", "call_rejected", "normal_clearing"]) {
      expect(describeHangup("mobile_dialing", "mobile", cause).errorCode).toBeNull();
    }
  });
});
