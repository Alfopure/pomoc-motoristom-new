import { beforeEach, describe, expect, it } from "vitest";

import { createFakeOpenAIFetch, createFakeSideband } from "@/test/fake-openai-live";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { TelnyxCommandError, TelnyxLiveCallsDisabledError } from "../telnyx/client";
import { loadAttempt, patchAttempt, transitionAttempt, type AiDemoAttempt } from "./attempts";
import { AI_DEMO_NEUTRAL_LINE } from "./config";
import { cleanupVerdict, describeAttempt, endAttempt, runAiDemoCleanup, startAiDemo, stopAiDemo, type AiDemoDeps } from "./orchestrator";

const ENV = {
  AI_DEMO_ENABLED: "true",
  AI_DEMO_ALLOWED_RECIPIENTS: "+421910988882",
  OPENAI_API_KEY: "sk-proj-test",
  OPENAI_LIVE_PROJECT_ID: "proj_test123",
  OPENAI_WEBHOOK_SECRET: "whsec_c2VjcmV0",
};

const TARGET = "+421910988882";

/** Short probe budgets; the probe's own behaviour is covered in `greeting.test.ts`. */
const FAST_PROBE = { probeOpenMs: 200, probeAppendedMs: 200, probeFirstDeltaMs: 300, probeWindowMs: 400, probeMaxEvents: 40 };

type Fixture = { h: TelephonyHarness; deps: AiDemoDeps; openai: ReturnType<typeof createFakeOpenAIFetch> };

function fixture(envOverrides: Record<string, string | undefined> = {}, options: { liveCalls?: boolean } = {}): Fixture {
  const h = createTelephonyHarness({ liveCalls: options.liveCalls ?? true });
  // The demo's caller ID is the second neutral line, which the harness does not seed.
  h.db.seed("motorist_telephony_lines", [
    {
      id: "00000000-0000-4000-8000-000000000208",
      organization_id: ORG,
      provider: "telnyx",
      phone_number: AI_DEMO_NEUTRAL_LINE,
      label: "Neutrálna linka 2",
      partner_name: null,
      ring_plan_id: null,
      ivr_menu_id: null,
      business_hours_id: null,
      environment: "production",
      active: true,
      telnyx_number_id: "3043592669122004035",
      external_id: null,
      metadata: {},
    },
  ]);

  const openai = createFakeOpenAIFetch();
  const deps: AiDemoDeps = {
    ...h.deps,
    env: { ...ENV, ...envOverrides },
    openAIFetch: openai.fetch,
    telnyxClientFactory: () => h.telnyx.client,
    deferMaintenance: undefined,
  };
  return { h, deps, openai };
}

async function start(f: Fixture, overrides: Partial<Parameters<typeof startAiDemo>[1]> = {}) {
  return startAiDemo(f.deps, { actorProfileId: PROFILES.o5, requestId: null, to: TARGET, ...overrides });
}

describe("startAiDemo gates", () => {
  it("dials nothing when the demo is switched off", async () => {
    const f = fixture({ AI_DEMO_ENABLED: undefined });
    await expect(start(f)).rejects.toMatchObject({ code: "ai_demo_disabled", status: 403 });
    expect(f.h.telnyx.of("dial")).toHaveLength(0);
    expect(f.h.rows("motorist_ai_demo_attempts")).toHaveLength(0);
  });

  it("names the missing configuration instead of failing opaquely", async () => {
    const f = fixture({ OPENAI_LIVE_PROJECT_ID: undefined });
    await expect(start(f)).rejects.toMatchObject({ code: "ai_demo_not_configured", status: 503, missing: ["OPENAI_LIVE_PROJECT_ID"] });
    expect(f.h.telnyx.of("dial")).toHaveLength(0);
  });

  it("refuses before writing a row when live calls are off", async () => {
    const f = fixture({}, { liveCalls: false });
    await expect(start(f)).rejects.toMatchObject({ status: 423 });
    expect(f.h.rows("motorist_ai_demo_attempts")).toHaveLength(0);
  });

  it("refuses a number outside the server recipient list", async () => {
    const f = fixture();
    await expect(start(f, { to: "+421905123456" })).rejects.toMatchObject({ code: "ai_demo_recipient_not_allowed", status: 403 });
    expect(f.h.telnyx.of("dial")).toHaveLength(0);
  });

  it("refuses a destination the organisation does not allow, before the demo list", async () => {
    const f = fixture({ AI_DEMO_ALLOWED_RECIPIENTS: "+15551234567" });
    await expect(start(f, { to: "+15551234567" })).rejects.toMatchObject({ code: "destination_not_allowed", status: 403 });
  });

  it("refuses our own line, which would loop the call back into the exchange", async () => {
    const f = fixture({ AI_DEMO_ALLOWED_RECIPIENTS: AI_DEMO_NEUTRAL_LINE });
    await expect(start(f, { to: AI_DEMO_NEUTRAL_LINE })).rejects.toMatchObject({ code: "ai_demo_target_is_own_line", status: 400 });
  });

  it("refuses an unparseable number", async () => {
    const f = fixture();
    await expect(start(f, { to: "not a number" })).rejects.toMatchObject({ code: "invalid_number", status: 400 });
  });

  it("fails closed when the caller ID is not an active line here", async () => {
    const f = fixture();
    f.h.db.update("motorist_telephony_lines", { active: false }, (row) => row.phone_number === AI_DEMO_NEUTRAL_LINE);
    await expect(start(f)).rejects.toMatchObject({ code: "ai_demo_from_invalid", status: 503 });
    expect(f.h.telnyx.of("dial")).toHaveLength(0);
  });

  it("stops at the daily limit", async () => {
    const f = fixture({ AI_DEMO_MAX_ATTEMPTS_PER_DAY: "1" });
    const first = await start(f);
    await transitionAttempt(f.deps.admin, first.attempt.id, ["sip_dialing"], { state: "ended" });
    await expect(start(f)).rejects.toMatchObject({ code: "ai_demo_daily_limit", status: 429 });
  });

  it("refuses a second demo while one is running", async () => {
    const f = fixture();
    await start(f);
    await expect(start(f)).rejects.toMatchObject({ code: "ai_demo_busy", status: 409 });
    expect(f.h.telnyx.of("dial")).toHaveLength(1);
  });

  it("requires context for the custom scenario", async () => {
    const f = fixture();
    await expect(start(f, { scenario: "custom", context: "krátke" })).rejects.toMatchObject({ code: "ai_demo_context_required" });
  });
});

describe("startAiDemo dial", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  it("dials the OpenAI SIP target first, with TLS and SRTP", async () => {
    await start(f);

    const dials = f.h.telnyx.of("dial");
    expect(dials).toHaveLength(1);
    const params = dials[0].params;
    expect(params.to).toBe("sip:proj_test123@sip.api.openai.com;transport=tls");
    expect(params.from).toBe(AI_DEMO_NEUTRAL_LINE);
    // GPT-Live requires SRTP; the PSTN leg must never carry it.
    expect(params.mediaEncryption).toBe("SRTP");
    expect(params.extra).toEqual({ sip_transport_protocol: "TLS", send_silence_when_idle: true });
    expect(params.timeLimitSecs).toBeGreaterThan(300);
  });

  it("leaves the Call Control application's webhook alone by default", async () => {
    await start(f);
    expect(f.h.telnyx.of("dial")[0].params.webhookUrl).toBeUndefined();
  });

  it("claims this call's events when a deployment URL is configured", async () => {
    // How a test deployment takes its own webhooks without editing the shared
    // Call Control application everybody else is using.
    const isolated = fixture({ AI_DEMO_WEBHOOK_BASE_URL: "https://demo.example.test" });
    await start(isolated);
    expect(isolated.h.telnyx.of("dial")[0].params.webhookUrl).toBe("https://demo.example.test/api/telephony/telnyx/webhook");
  });

  it("puts the correlation token in the SIP From display name", async () => {
    const result = await start(f);
    const params = f.h.telnyx.of("dial")[0].params;
    expect(params.fromDisplayName).toBe(result.attempt.correlation_token);
    expect(params.fromDisplayName).toMatch(/^PM-AI-DEMO-[0-9a-f]{8}$/);
  });

  it("does not dial the customer's phone yet", async () => {
    await start(f);
    const targets = f.h.telnyx.of("dial").map((call) => call.params.to);
    expect(targets).not.toContain(TARGET);
  });

  it("returns the same attempt for a replayed request instead of dialling twice", async () => {
    const requestId = "11111111-2222-4333-8444-555555555555";
    const first = await start(f, { requestId });
    const second = await start(f, { requestId });
    expect(second.reused).toBe(true);
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(f.h.telnyx.of("dial")).toHaveLength(1);
  });

  it("ends the attempt when the provider refuses the dial", async () => {
    f.h.telnyx.failNext("dial", new TelnyxCommandError({ code: "10010", status: 422, detail: "number cannot originate" }));
    await expect(start(f)).rejects.toMatchObject({ code: "ai_demo_10010" });

    const row = f.h.rows("motorist_ai_demo_attempts")[0] as unknown as AiDemoAttempt;
    expect(row.state).toBe("failed");
    expect(row.error_code).toBe("sip_dial_rejected");
    expect(row.sip_dial_outcome).toBe("rejected");
  });

  it("keeps an uncertain dial open rather than redialling", async () => {
    f.h.telnyx.failNext("dial", new TelnyxCommandError({ code: "internal", status: 503, retryable: true }));
    await expect(start(f)).rejects.toMatchObject({ status: 502 });

    const row = f.h.rows("motorist_ai_demo_attempts")[0] as unknown as AiDemoAttempt;
    expect(row.sip_dial_outcome).toBe("unknown");
    expect(row.state).toBe("ending");
    expect(f.h.telnyx.of("dial")).toHaveLength(1);
  });
});

describe("endAttempt", () => {
  it("hangs up both legs once and closes the row", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], {
      state: "talking",
      telnyx_mobile_call_control_id: "cc-mobile",
      openai_session_id: "live_running",
    });

    const result = await endAttempt(f.deps, attempt.id, 5_000, "inline");

    expect(result.state).toBe("ended");
    const hangups = f.h.telnyx.of("hangup").map((call) => call.params.callControlId);
    expect(hangups).toContain("cc-mobile");
    expect(f.openai.calls.filter((call) => call.url.includes("/hangup"))).toHaveLength(1);

    // Idempotent: the same call again must not touch the provider.
    const before = f.h.telnyx.of("hangup").length;
    await endAttempt(f.deps, attempt.id, 5_000, "inline");
    expect(f.h.telnyx.of("hangup")).toHaveLength(before);
  });

  it("counts a leg Telnyx has already forgotten as released", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], { state: "talking", telnyx_mobile_call_control_id: "cc-mobile" });
    f.h.telnyx.failAlways("hangup", new TelnyxCommandError({ code: "90018", status: 422, detail: "call is not active" }));

    const result = await endAttempt(f.deps, attempt.id, 5_000, "inline");

    expect(result.state).toBe("ended");
  });

  it("marks the row failed when an error code was recorded", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], { state: "ending", end_reason: "accept_lost", error_code: "accept_lost" });

    const result = await endAttempt(f.deps, attempt.id, 5_000, "inline");

    expect(result.state).toBe("failed");
    expect((await loadAttempt(f.deps.admin, ORG, attempt.id))?.error_code).toBe("accept_lost");
  });

  it("does not let an unresolved hangup declare the demo finished", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], { state: "talking", telnyx_mobile_call_control_id: "cc-mobile" });
    f.h.telnyx.failAlways("hangup", new TelnyxCommandError({ code: "internal", status: 500, retryable: true }));

    const result = await endAttempt(f.deps, attempt.id, 5_000, "inline");

    expect(result.state).toBe("ending");
    const row = await loadAttempt(f.deps.admin, ORG, attempt.id);
    expect(row?.cleanup_attempts).toBe(1);
    expect(row?.cleanup_next_attempt_at).not.toBeNull();
  });
});

describe("stopAiDemo", () => {
  it("ends a running demo even when new calls have been switched off", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], { state: "talking", telnyx_mobile_call_control_id: "cc-mobile" });
    // The kill switch must not be able to strand a live call.
    f.h.db.update("motorist_telephony_settings", { live_calls_enabled: false }, () => true);

    const stopped = await stopAiDemo(f.deps, attempt.id);

    expect(stopped?.state).toBe("ended");
    expect(stopped?.end_reason).toBe("admin_stop");
    expect(stopped?.error_code).toBeNull();
  });

  it("is idempotent", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    await stopAiDemo(f.deps, attempt.id);
    const again = await stopAiDemo(f.deps, attempt.id);
    expect(again?.state).toBe("ended");
  });
});

describe("cleanupVerdict", () => {
  const base = {
    state: "sip_dialing",
    deadline_at: "2026-09-03T09:00:00.000Z",
    requested_at: "2026-09-03T08:00:00.000Z",
    sip_dialed_at: "2026-09-03T08:00:00.000Z",
    sip_dial_outcome: "accepted",
    mobile_dial_outcome: "none",
    telnyx_sip_call_control_id: "cc-sip",
    cleanup_next_attempt_at: null,
  } as unknown as AiDemoAttempt;

  const at = (iso: string) => new Date(iso).getTime();

  it("says nothing while a state is still young", () => {
    expect(cleanupVerdict(base, at("2026-09-03T08:00:30.000Z"))).toBeNull();
  });

  it("fires the deadline for any non-terminal state", () => {
    expect(cleanupVerdict(base, at("2026-09-03T09:00:01.000Z"))).toEqual({ endReason: "deadline", errorCode: null });
  });

  it("distinguishes a dial that never left from one that was never answered", () => {
    const late = at("2026-09-03T08:05:00.000Z");
    expect(cleanupVerdict({ ...base, sip_dial_outcome: "none" }, late)).toEqual({ endReason: "dial_failed", errorCode: "dial_failed" });
    expect(cleanupVerdict({ ...base, sip_dial_outcome: "unknown", telnyx_sip_call_control_id: null }, late)).toEqual({ endReason: "dial_unknown", errorCode: "dial_unknown" });
    expect(cleanupVerdict(base, late)).toEqual({ endReason: "sip_no_answer", errorCode: "sip_no_answer" });
  });

  it("never ends a live conversation on staleness alone", () => {
    const talking = { ...base, state: "talking", bridged_at: "2026-09-03T08:00:00.000Z" } as unknown as AiDemoAttempt;
    expect(cleanupVerdict(talking, at("2026-09-03T08:04:00.000Z"))).toBeNull();
  });

  it("pushes a lost greeting forward without ending the call", () => {
    const bridged = { ...base, state: "bridged", bridged_at: "2026-09-03T08:00:00.000Z" } as unknown as AiDemoAttempt;
    expect(cleanupVerdict(bridged, at("2026-09-03T08:01:00.000Z"))).toEqual({ endReason: null, errorCode: null });
  });

  it("retries an ending row only when its backoff has passed", () => {
    const ending = { ...base, state: "ending", cleanup_next_attempt_at: "2026-09-03T08:10:00.000Z" } as unknown as AiDemoAttempt;
    expect(cleanupVerdict(ending, at("2026-09-03T08:05:00.000Z"))).toBeNull();
    expect(cleanupVerdict(ending, at("2026-09-03T08:11:00.000Z"))).toEqual({ endReason: null, errorCode: null });
  });
});

describe("runAiDemoCleanup", () => {
  it("releases an attempt whose webhooks never arrived", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    f.h.advance(10 * 60_000);

    const detail = await runAiDemoCleanup(f.deps, { deadline: Date.now() + 5_000 });

    expect(detail.ended).toBe(1);
    const row = await loadAttempt(f.deps.admin, ORG, attempt.id);
    expect(row?.state).toBe("failed");
    expect(row?.end_reason).toBe("deadline");
  });

  it("starts nothing: the only provider command it may issue is a hangup", async () => {
    const f = fixture();
    await start(f);
    const dialsBefore = f.h.telnyx.of("dial").length;
    f.h.advance(10 * 60_000);

    await runAiDemoCleanup(f.deps, { deadline: Date.now() + 5_000 });

    expect(f.h.telnyx.of("dial")).toHaveLength(dialsBefore);
  });

  it("stops at its deadline instead of running over the cron budget", async () => {
    const f = fixture();
    await start(f);
    const detail = await runAiDemoCleanup(f.deps, { deadline: Date.now() - 1 });
    expect(detail.timedOut).toBe(1);
    expect(detail.checked).toBe(0);
  });
});

describe("describeAttempt", () => {
  it("masks the number and never exposes the prompt or the context", async () => {
    const f = fixture();
    const { attempt } = await start(f, { context: "Pán Novák, Škoda Octavia" });
    const described = describeAttempt((await loadAttempt(f.deps.admin, ORG, attempt.id))!);

    expect(described.targetMasked).toBe("+421910•••882");
    expect(JSON.stringify(described)).not.toContain("910988882");
    expect(JSON.stringify(described)).not.toContain("Novák");
  });
});

describe("the greeting probe", () => {
  it("records the time to her first word without keeping what she said", async () => {
    const f = fixture();
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 5, event: { type: "session.instructions.appended", client_event_id: "greet-" } },
        { delayMs: 15, event: { type: "session.output_transcript.delta", delta: "Dobrý deň, tu je Veronika" } },
      ],
    });
    const deps: AiDemoDeps = { ...f.deps, webSocketFactory: sideband.factory, probeLimits: FAST_PROBE };

    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], {
      state: "bridged",
      openai_session_id: "live_running",
      bridged_at: f.h.now().toISOString(),
      greeting_status: "requested",
    });

    const { runGreetingAndFinish } = await import("./orchestrator");
    await runGreetingAndFinish(deps, attempt.id);

    const row = await loadAttempt(f.deps.admin, ORG, attempt.id);
    expect(row?.state).toBe("talking");
    expect(row?.greeting_status).toBe("heard_started");
    expect(row?.first_transcript_at).not.toBeNull();
    expect(JSON.stringify(row?.latency_probe)).not.toContain("Veronika");
  });

  it("still starts the conversation when the probe cannot connect", async () => {
    const f = fixture();
    const sideband = createFakeSideband({ failOpen: true });
    const deps: AiDemoDeps = { ...f.deps, webSocketFactory: sideband.factory, probeLimits: FAST_PROBE };

    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], {
      state: "bridged",
      openai_session_id: "live_running",
      bridged_at: f.h.now().toISOString(),
      greeting_status: "requested",
    });

    const { runGreetingAndFinish } = await import("./orchestrator");
    await runGreetingAndFinish(deps, attempt.id);

    const row = await loadAttempt(f.deps.admin, ORG, attempt.id);
    expect(row?.state).toBe("talking");
    expect(row?.greeting_status).toBe("failed");
    // A probe failure is not a call failure.
    expect(row?.error_code).toBeNull();
  });
});

describe("things the request body must not be able to decide", () => {
  it("ignores a SIP target or a webhook URL smuggled into the body", async () => {
    const f = fixture();
    // The model never sees a number, and a client never picks where the call
    // goes or where its events land.
    await startAiDemo(f.deps, {
      actorProfileId: PROFILES.o5,
      requestId: null,
      to: TARGET,
      ...({ sipUri: "sip:attacker@evil.test", webhookUrl: "https://evil.test/hook" } as Record<string, unknown>),
    });

    const dial = f.h.telnyx.of("dial")[0].params;
    expect(dial.to).toBe("sip:proj_test123@sip.api.openai.com;transport=tls");
    expect(dial.webhookUrl).toBeUndefined();
  });

  it("ignores a scenario or a voice it does not know", async () => {
    const f = fixture();
    const { attempt } = await start(f, { scenario: "steal_everything", voice: "attacker-voice" });
    expect(attempt.scenario).toBe("replacement_vehicle_return");
    expect((attempt.metadata as { voice?: string }).voice).toBe("gleam");
  });
});

describe("the kill switch thrown mid-flight", () => {
  it("records that live calls were switched off, not that the number failed", async () => {
    const f = fixture();
    f.h.telnyx.failNext("dial", new TelnyxLiveCallsDisabledError());

    await expect(start(f)).rejects.toMatchObject({ status: 423 });

    const row = f.h.rows("motorist_ai_demo_attempts")[0] as unknown as AiDemoAttempt;
    expect(row.error_code).toBe("live_calls_disabled");
    expect(row.end_reason).toBe("live_calls_disabled");
  });
});

describe("a dial whose answer never arrived", () => {
  it("leaves the attempt open rather than redialling", async () => {
    const f = fixture();
    // The provider performed the dial; the acknowledgement was lost.
    f.h.telnyx.loseNextResponse("dial");

    await expect(start(f)).rejects.toMatchObject({ status: 502 });

    const row = f.h.rows("motorist_ai_demo_attempts")[0] as unknown as AiDemoAttempt;
    expect(row.sip_dial_outcome).toBe("unknown");
    expect(row.state).toBe("ending");
    // One dial, ever. A second would be a second billable call to nobody.
    expect(f.h.telnyx.of("dial")).toHaveLength(1);
  });

  it("adopts the call from the webhook that follows, so the leg can still be hung up", async () => {
    const f = fixture();
    f.h.telnyx.loseNextResponse("dial");
    await expect(start(f)).rejects.toThrow();
    const attempt = f.h.rows("motorist_ai_demo_attempts")[0] as unknown as AiDemoAttempt;

    const { adoptLeg } = await import("./attempts");
    await adoptLeg(f.deps.admin, attempt.id, "sip", { callControlId: "cc-late" });

    expect((await loadAttempt(f.deps.admin, ORG, attempt.id))?.telnyx_sip_call_control_id).toBe("cc-late");
  });
});

describe("serving the transcript while the call runs", () => {
  it("returns only what is newer than the cursor", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    await patchAttempt(f.deps.admin, attempt.id, {
      transcript: [
        { ms: 900, dir: "out", text: "Dobrý deň," },
        { ms: 1_400, dir: "out", text: " tu je Veronika." },
        { ms: 4_000, dir: "in", text: "áno" },
      ],
    });
    const row = (await loadAttempt(f.deps.admin, ORG, attempt.id))!;

    // The poll asks every two seconds; sending the whole conversation back each
    // time would be most of a minute of speech repeated 150 times.
    const since = describeAttempt(row, { includeTranscript: true, transcriptSince: 1_400 });
    expect(since.transcript).toHaveLength(1);
    expect(since.transcript?.[0].text).toBe("áno");

    const whole = describeAttempt(row, { includeTranscript: true });
    expect(whole.transcript).toHaveLength(3);
  });

  it("still says nothing when the transcript was not asked for", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    await patchAttempt(f.deps.admin, attempt.id, { transcript: [{ ms: 1, dir: "out", text: "tajné" }] });
    const row = (await loadAttempt(f.deps.admin, ORG, attempt.id))!;

    expect(JSON.stringify(describeAttempt(row))).not.toContain("tajné");
    expect(describeAttempt(row).hasTranscript).toBe(true);
  });
});

describe("ending the call when the conversation ends", () => {
  async function callWithFarewell(env: Record<string, string | undefined>, closing: string) {
    const f = fixture(env);
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 5, event: { type: "session.instructions.appended" } },
        { delayMs: 20, event: { type: "session.output_transcript.delta", delta: "Dobrý deň, tu je Veronika." } },
        { delayMs: 60, event: { type: "session.input_transcript.delta", delta: "áno, dobre" } },
        { delayMs: 100, event: { type: "session.output_transcript.delta", delta: closing } },
      ],
    });
    const deps: AiDemoDeps = {
      ...f.deps,
      webSocketFactory: sideband.factory,
      probeLimits: { ...FAST_PROBE, probeWindowMs: 1_200, probeCheckpointMs: 120, keepTranscript: true, farewellSilenceMs: 200 },
    };

    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], {
      state: "bridged",
      openai_session_id: "live_running",
      telnyx_mobile_call_control_id: "cc-mobile",
      telnyx_sip_call_control_id: "cc-sip",
      bridged_at: new Date(Date.now() - 60_000).toISOString(),
      greeting_status: "requested",
    });

    const { runGreetingAndFinish } = await import("./orchestrator");
    await runGreetingAndFinish(deps, attempt.id);
    return { f, attempt };
  }

  it("hangs up once she has said goodbye and the line is quiet", async () => {
    const { f, attempt } = await callWithFarewell({ AI_DEMO_AUTO_HANGUP: "true" }, " Ďakujem, dovidenia.");

    const row = await loadAttempt(f.deps.admin, ORG, attempt.id);
    expect(row?.state).toBe("ended");
    expect(row?.end_reason).toBe("farewell");
    // Ending a conversation normally is not a failure.
    expect(row?.error_code).toBeNull();
    expect(f.h.telnyx.of("hangup").length).toBeGreaterThan(0);
  });

  it("leaves a call running when she has not said goodbye", async () => {
    const { f, attempt } = await callWithFarewell({ AI_DEMO_AUTO_HANGUP: "true" }, " A kedy by vám to vyhovovalo?");

    const row = await loadAttempt(f.deps.admin, ORG, attempt.id);
    expect(row?.end_reason).not.toBe("farewell");
    expect(["bridged", "talking"]).toContain(row?.state);
  });

  it("does nothing at all while the switch is off", async () => {
    const { f, attempt } = await callWithFarewell({ AI_DEMO_AUTO_HANGUP: undefined }, " Ďakujem, dovidenia.");

    const row = await loadAttempt(f.deps.admin, ORG, attempt.id);
    expect(row?.end_reason).not.toBe("farewell");
    expect(f.h.telnyx.of("hangup")).toHaveLength(0);
  });
});

describe("a line that has gone quiet", () => {
  /** A call where she spoke, the caller answered, and then nothing. */
  async function silentCall(env: Record<string, string | undefined>, judgeBody?: unknown) {
    const openai = createFakeOpenAIFetch();
    const f = fixture(env);
    const sent: string[] = [];
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 5, event: { type: "session.instructions.appended" } },
        { delayMs: 20, event: { type: "session.output_transcript.delta", delta: "Kedy by ste vrátili náhradné vozidlo?" } },
      ],
    });
    const wrapped = ((url: string, init: { headers: Record<string, string> }) => {
      const socket = sideband.factory(url, init);
      const send = socket.send.bind(socket);
      socket.send = (data: string) => {
        sent.push(data);
        send(data);
      };
      return socket;
    }) as typeof sideband.factory;

    const deps: AiDemoDeps = {
      ...f.deps,
      webSocketFactory: wrapped,
      probeLimits: { ...FAST_PROBE, probeWindowMs: 900, probeCheckpointMs: 100, keepTranscript: true, nudgeAfterMs: 120, judgeAfterMs: 300, judgeEveryMs: 150, maxNudges: 2, farewellSilenceMs: 200, closingGraceMs: 150 },
      openAIFetch: judgeBody
        ? ((async (input: string | URL | Request, init?: RequestInit) => {
            const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (target.endsWith("/responses")) return new Response(JSON.stringify({ output_text: JSON.stringify(judgeBody) }), { status: 200 });
            return openai.fetch(input, init);
          }) as typeof fetch)
        : openai.fetch,
    };

    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], {
      state: "bridged",
      openai_session_id: "live_running",
      telnyx_mobile_call_control_id: "cc-mobile",
      bridged_at: new Date(Date.now() - 30_000).toISOString(),
      greeting_status: "requested",
    });

    const { runGreetingAndFinish } = await import("./orchestrator");
    await runGreetingAndFinish(deps, attempt.id);
    return { f, attempt, sent };
  }

  it("has her check in rather than sitting there", async () => {
    const { sent } = await silentCall({ AI_DEMO_JUDGE_SILENCE: "true", AI_DEMO_AUTO_HANGUP: "true" });

    const nudges = sent.map((raw) => JSON.parse(raw)).filter((command) => String(command.event_id ?? "").startsWith("nudge-"));
    expect(nudges.length).toBeGreaterThan(0);
    expect(String(nudges[0].content)).toContain("či je tam");
  });

  it("stops checking in rather than pestering", async () => {
    const { sent } = await silentCall({ AI_DEMO_JUDGE_SILENCE: "true" });

    const asked = sent
      .map((raw) => JSON.parse(raw))
      .filter((command) => command.type === "session.instructions.append" && String(command.event_id ?? "").startsWith("nudge-"));
    expect(asked.length).toBeLessThanOrEqual(2);
  });

  it("has her say goodbye before the line drops", async () => {
    // A call that simply stops is the one thing a listener notices, and she has
    // no other way to close: she cannot hang up, so somebody has to ask her.
    const { f, attempt, sent } = await silentCall(
      { AI_DEMO_JUDGE_SILENCE: "true", AI_DEMO_AUTO_HANGUP: "true" },
      { action: "hangup", say: null, reason: "volajúci sa rozlúčil a položil" },
    );

    const asked = sent.map((raw) => JSON.parse(raw)).filter((command) => String(command.content ?? "").includes("rozlúč"));
    expect(asked.length).toBeGreaterThan(0);

    const row = await loadAttempt(f.deps.admin, ORG, attempt.id);
    expect(row?.state).toBe("ended");
    expect(row?.end_reason).toBe("judged_over");
    expect(row?.error_code).toBeNull();
  });

  it("does not end the call on a verdict of carrying on", async () => {
    const { f, attempt } = await silentCall(
      { AI_DEMO_JUDGE_SILENCE: "true", AI_DEMO_AUTO_HANGUP: "true" },
      { action: "continue", say: null, reason: "volajúci premýšľa" },
    );

    const row = await loadAttempt(f.deps.admin, ORG, attempt.id);
    expect(row?.end_reason).not.toBe("judged_over");
  });

  it("says nothing and asks nobody while the switch is off", async () => {
    const { f, attempt, sent } = await silentCall({ AI_DEMO_JUDGE_SILENCE: undefined, AI_DEMO_AUTO_HANGUP: "true" });

    expect(sent.map((raw) => JSON.parse(raw)).filter((c) => String(c.event_id ?? "").startsWith("nudge-"))).toHaveLength(0);
    expect((await loadAttempt(f.deps.admin, ORG, attempt.id))?.end_reason).not.toBe("judged_over");
  });
});

describe("one probe per call", () => {
  it("greets once even when two invocations both try", async () => {
    // The webhook hands off to the listener and listens itself if that fails.
    // A hand-off that timed out may have started one anyway — and she said
    // hello twice on a live call.
    const f = fixture();
    const sent: string[] = [];
    const sideband = createFakeSideband({ onInstructions: [{ delayMs: 5, event: { type: "session.instructions.appended" } }] });
    const wrapped = ((url: string, init: { headers: Record<string, string> }) => {
      const socket = sideband.factory(url, init);
      const send = socket.send.bind(socket);
      socket.send = (data: string) => {
        sent.push(data);
        send(data);
      };
      return socket;
    }) as typeof sideband.factory;

    const deps: AiDemoDeps = { ...f.deps, webSocketFactory: wrapped, probeLimits: { ...FAST_PROBE, probeWindowMs: 200 } };
    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], {
      state: "bridged",
      openai_session_id: "live_running",
      bridged_at: f.h.now().toISOString(),
      greeting_status: "requested",
    });

    const { runGreetingAndFinish } = await import("./orchestrator");
    await Promise.all([runGreetingAndFinish(deps, attempt.id), runGreetingAndFinish(deps, attempt.id)]);

    const greetings = sent.map((raw) => JSON.parse(raw)).filter((command) => String(command.event_id ?? "").startsWith("greet-"));
    expect(greetings).toHaveLength(1);
  });

  it("records who took the call, so a later invocation can see it was taken", async () => {
    const f = fixture();
    const { attempt } = await start(f);
    await transitionAttempt(f.deps.admin, attempt.id, ["sip_dialing"], {
      state: "bridged", openai_session_id: "live_running", bridged_at: f.h.now().toISOString(), greeting_status: "requested",
    });

    const { claimProbe } = await import("./attempts");
    expect(await claimProbe(f.deps.admin, attempt.id, f.h.now())).not.toBeNull();
    expect(await claimProbe(f.deps.admin, attempt.id, f.h.now())).toBeNull();
  });
});
