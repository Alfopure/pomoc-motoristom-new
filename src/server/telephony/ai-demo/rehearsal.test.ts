import { describe, expect, it } from "vitest";

import { createFakeOpenAIFetch, createFakeSideband } from "@/test/fake-openai-live";
import { createTelephonyHarness, CONNECTION_ID, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { processTelnyxEvent } from "../telnyx/event-processor";
import { loadAttempt } from "./attempts";
import { AI_DEMO_NEUTRAL_LINE } from "./config";
import { aiDemoClientState } from "./identity";
import { handleOpenAIIncoming } from "./openai-events";
import { startAiDemo, type AiDemoDeps } from "./orchestrator";

/**
 * The whole demo, start to finish, with both providers faked.
 *
 * This is the rehearsal: the one test that answers "does the flow work" without
 * a deployment, a phone or a cent of provider spend. Every step is driven by
 * the same entry point production uses — the start route's service, the OpenAI
 * webhook handler, and `processTelnyxEvent` with a real signed-shape envelope —
 * so the ordering, the transitions and the latency measurement are exercised
 * for real. Only the two providers are stand-ins.
 *
 * It also pins the two things a live test cannot easily prove: that the
 * customer's phone is dialled exactly once, and that both legs are released.
 */

const ENV = {
  AI_DEMO_ENABLED: "true",
  AI_DEMO_ALLOWED_RECIPIENTS: "+421910988882",
  OPENAI_API_KEY: "sk-proj-test",
  OPENAI_LIVE_PROJECT_ID: "proj_test123",
  OPENAI_WEBHOOK_SECRET: "whsec_c2VjcmV0",
};

const TARGET = "+421910988882";
const FAST_PROBE = { probeOpenMs: 100, probeAppendedMs: 100, probeFirstDeltaMs: 150, probeWindowMs: 200, probeMaxEvents: 20 };

function seedDemoLine(h: TelephonyHarness) {
  h.db.seed("motorist_telephony_lines", [
    {
      id: "00000000-0000-4000-8000-000000000208", organization_id: ORG, provider: "telnyx", phone_number: AI_DEMO_NEUTRAL_LINE,
      label: "Neutrálna linka 2", partner_name: null, ring_plan_id: null, ivr_menu_id: null, business_hours_id: null,
      environment: "production", active: true, telnyx_number_id: "3043592669122004035", external_id: null, metadata: {},
    },
  ]);
}

function telnyxEnvelope(options: { type: string; attemptId: string; leg: "sip" | "mobile"; eventId: string; hangupCause?: string }) {
  return {
    data: {
      record_type: "event",
      event_type: options.type,
      id: options.eventId,
      occurred_at: new Date().toISOString(),
      payload: {
        call_control_id: options.leg === "sip" ? "cc-sip" : "cc-mobile",
        call_leg_id: options.leg === "sip" ? "leg-sip" : "leg-mobile",
        call_session_id: "telnyx-session-1",
        connection_id: CONNECTION_ID,
        client_state: aiDemoClientState(options.attemptId, options.leg),
        direction: "outgoing",
        from: AI_DEMO_NEUTRAL_LINE,
        to: TARGET,
        ...(options.hangupCause ? { hangup_cause: options.hangupCause, hangup_source: "callee" } : {}),
      },
    },
  };
}

describe("the AI demo, rehearsed offline", () => {
  it("runs the happy path and leaves nothing behind", async () => {
    const h = createTelephonyHarness();
    seedDemoLine(h);
    const openai = createFakeOpenAIFetch();
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 5, event: { type: "session.instructions.appended" } },
        { delayMs: 30, event: { type: "session.output_transcript.delta", delta: "Dobrý deň, tu je Veronika" } },
        { delayMs: 80, event: { type: "session.input_transcript.delta", delta: "áno, mám chvíľku" } },
        { delayMs: 120, event: { type: "session.output_transcript.delta", delta: "Ďakujem" } },
      ],
    });

    // `after()` work runs inline here, in the order the host would run it.
    const deferred: Array<() => Promise<void>> = [];
    const deps: AiDemoDeps = {
      ...h.deps,
      env: ENV,
      openAIFetch: openai.fetch,
      telnyxClientFactory: () => h.telnyx.client,
      webSocketFactory: sideband.factory,
      probeLimits: FAST_PROBE,
      deferMaintenance: (work) => void deferred.push(work),
    };
    const drain = async () => {
      while (deferred.length > 0) await deferred.shift()!();
    };

    // 1. The admin presses "Zavolať". Only the AI leg is dialled.
    const { attempt } = await startAiDemo(deps, {
      actorProfileId: PROFILES.o5,
      requestId: "11111111-2222-4333-8444-555555555555",
      to: "0910 988 882",
      scenario: "replacement_vehicle_return",
      context: "Pán Novák, Škoda Octavia, náhradné vozidlo Fabia",
    });
    expect(attempt.state).toBe("sip_dialing");
    expect(h.telnyx.of("dial").map((call) => call.params.to)).toEqual(["sip:proj_test123@sip.api.openai.com;transport=tls"]);

    // 2. Telnyx reports the SIP leg exists.
    await processTelnyxEvent(deps, telnyxEnvelope({ type: "call.initiated", attemptId: attempt.id, leg: "sip", eventId: "evt-1" }));

    // 3. OpenAI announces the inbound session; we accept it synchronously.
    const accepted = await handleOpenAIIncoming(deps, {
      type: "live.transport.incoming",
      data: { session_id: "live_rehearsal", type: "sip", sip_headers: [{ name: "From", value: `"${attempt.correlation_token}" <sip:${AI_DEMO_NEUTRAL_LINE}@t>` }] },
    });
    expect(accepted).toEqual({ outcome: "accepted", attemptId: attempt.id });
    expect((await loadAttempt(deps.admin, ORG, attempt.id))?.state).toBe("ai_accepted");

    // 4. The AI leg answers → the customer's phone is dialled, bridged on answer.
    await processTelnyxEvent(deps, telnyxEnvelope({ type: "call.answered", attemptId: attempt.id, leg: "sip", eventId: "evt-2" }));
    const mobileDial = h.telnyx.of("dial").find((call) => call.params.to === TARGET);
    expect(mobileDial?.params.bridgeOnAnswer).toBe(true);
    expect((await loadAttempt(deps.admin, ORG, attempt.id))?.state).toBe("mobile_dialing");

    // 5. The customer answers. The greeting is scheduled after the response.
    await processTelnyxEvent(deps, telnyxEnvelope({ type: "call.answered", attemptId: attempt.id, leg: "mobile", eventId: "evt-3" }));
    expect(deferred).toHaveLength(1);
    await drain();

    // 6. She spoke, and we know how long it took.
    const talking = await loadAttempt(deps.admin, ORG, attempt.id);
    expect(talking?.state).toBe("talking");
    expect(talking?.greeting_status).toBe("heard_started");
    const latency = (talking?.metadata as { latency?: { first_word_ms?: number; response_gaps_ms?: number[] } }).latency;
    expect(typeof latency?.first_word_ms).toBe("number");
    expect(latency?.response_gaps_ms?.length).toBeGreaterThan(0);
    // Timings only: the conversation itself is never stored.
    expect(JSON.stringify(talking?.latency_probe)).not.toContain("Veronika");
    expect(JSON.stringify(talking?.metadata)).not.toContain("Dobrý deň");

    // 7. The customer hangs up. Both legs and the AI session are released.
    await processTelnyxEvent(deps, telnyxEnvelope({ type: "call.hangup", attemptId: attempt.id, leg: "mobile", eventId: "evt-4", hangupCause: "normal_clearing" }));
    await drain();

    const ended = await loadAttempt(deps.admin, ORG, attempt.id);
    expect(ended?.state).toBe("ended");
    expect(ended?.error_code).toBeNull();
    expect(ended?.end_reason).toBe("mobile_normal_clearing");
    expect(h.telnyx.of("dial").filter((call) => call.params.to === TARGET)).toHaveLength(1);
    // Only the AI leg is hung up: the customer's leg reported its own hangup,
    // and asking Telnyx to end a leg it already ended is a wasted command.
    expect(h.telnyx.of("hangup").map((call) => call.params.callControlId)).toEqual(["cc-sip"]);
    expect(ended?.mobile_hangup_done_at).not.toBeNull();
    expect(ended?.sip_hangup_done_at).not.toBeNull();
    expect(openai.calls.filter((call) => call.url.includes("/hangup"))).toHaveLength(1);

    // 8. Nothing of the dispatch exchange was touched.
    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
    expect(h.rows("motorist_call_legs")).toHaveLength(0);

    // 9. The line is free for the next demo.
    expect(h.rows("motorist_ai_demo_attempts")).toHaveLength(1);
  });

  it("disturbs nobody when SIP is not enabled on the OpenAI project", async () => {
    const h = createTelephonyHarness();
    seedDemoLine(h);
    // The realistic first-attempt failure: the INVITE is refused, so Telnyx
    // reports the SIP leg gone before the customer's phone ever rings.
    const openai = createFakeOpenAIFetch();
    const deferred: Array<() => Promise<void>> = [];
    const deps: AiDemoDeps = {
      ...h.deps, env: ENV, openAIFetch: openai.fetch, telnyxClientFactory: () => h.telnyx.client,
      probeLimits: FAST_PROBE, deferMaintenance: (work) => void deferred.push(work),
    };

    const { attempt } = await startAiDemo(deps, { actorProfileId: PROFILES.o5, requestId: null, to: TARGET });
    await processTelnyxEvent(deps, telnyxEnvelope({ type: "call.hangup", attemptId: attempt.id, leg: "sip", eventId: "evt-x", hangupCause: "call_rejected" }));
    while (deferred.length > 0) await deferred.shift()!();

    const row = await loadAttempt(deps.admin, ORG, attempt.id);
    expect(row?.state).toBe("failed");
    expect(row?.error_code).toBe("sip_rejected");
    // The whole point of dialling the AI leg first.
    expect(h.telnyx.of("dial").filter((call) => call.params.to === TARGET)).toHaveLength(0);
  });

  it("is completely inert while the switch is off", async () => {
    const h = createTelephonyHarness();
    seedDemoLine(h);
    const deps: AiDemoDeps = { ...h.deps, env: { ...ENV, AI_DEMO_ENABLED: undefined }, telnyxClientFactory: () => h.telnyx.client };

    await expect(startAiDemo(deps, { actorProfileId: PROFILES.o5, requestId: null, to: TARGET })).rejects.toMatchObject({ code: "ai_demo_disabled" });

    // And an ordinary inbound call still behaves exactly as before.
    const result = await processTelnyxEvent(h.deps, {
      data: {
        record_type: "event", event_type: "call.initiated", id: "evt-human", occurred_at: new Date().toISOString(),
        payload: {
          call_control_id: "cc-human", call_leg_id: "leg-human", call_session_id: "telnyx-human",
          connection_id: CONNECTION_ID, client_state: null, direction: "incoming", from: "+421905123456", to: "+421232408700",
        },
      },
    });
    expect(result.status).toBe(200);
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
    expect(h.rows("motorist_ai_demo_attempts")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });
});
