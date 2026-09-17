import { describe, expect, it } from "vitest";

import { createFakeOpenAIFetch } from "@/test/fake-openai-live";
import { createTelephonyHarness, CONNECTION_ID, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { processTelnyxEvent } from "../telnyx/event-processor";
import { loadAttempt, transitionAttempt } from "./attempts";
import { AI_DEMO_NEUTRAL_LINE } from "./config";
import { aiDemoClientState } from "./identity";
import { startAiDemo, type AiDemoDeps } from "./orchestrator";

/**
 * The branch inside `processTelnyxEvent`.
 *
 * Two things have to hold at once: a demo leg must reach the demo handler, and
 * a human call must behave exactly as it did before the branch existed. The
 * second is the one worth a test — the AI demo is an experiment, and the
 * dispatch exchange is the business.
 */

const ENV = {
  AI_DEMO_ENABLED: "true",
  AI_DEMO_ALLOWED_RECIPIENTS: "+421910988882",
  OPENAI_API_KEY: "sk-proj-test",
  OPENAI_LIVE_PROJECT_ID: "proj_test123",
  OPENAI_WEBHOOK_SECRET: "whsec_c2VjcmV0",
};

function seedDemoLine(h: TelephonyHarness) {
  h.db.seed("motorist_telephony_lines", [
    {
      id: "00000000-0000-4000-8000-000000000208", organization_id: ORG, provider: "telnyx", phone_number: AI_DEMO_NEUTRAL_LINE,
      label: "Neutrálna linka 2", partner_name: null, ring_plan_id: null, ivr_menu_id: null, business_hours_id: null,
      environment: "production", active: true, telnyx_number_id: "3043592669122004035", external_id: null, metadata: {},
    },
  ]);
}

function demoDeps(h: TelephonyHarness): AiDemoDeps {
  return {
    ...h.deps,
    env: ENV,
    openAIFetch: createFakeOpenAIFetch().fetch,
    telnyxClientFactory: () => h.telnyx.client,
    webSocketFactory: () => {
      throw new Error("sideband_disabled_in_test");
    },
    probeLimits: { probeOpenMs: 20, probeAppendedMs: 20, probeFirstDeltaMs: 30, probeWindowMs: 50, probeMaxEvents: 10 },
  };
}

function envelope(options: { type: string; clientState: string | null; callControlId: string; eventId: string }) {
  return {
    data: {
      record_type: "event",
      event_type: options.type,
      id: options.eventId,
      occurred_at: "2026-09-03T08:00:00.000Z",
      payload: {
        call_control_id: options.callControlId,
        call_leg_id: `leg-${options.callControlId}`,
        call_session_id: "telnyx-session-demo",
        connection_id: CONNECTION_ID,
        client_state: options.clientState,
        direction: "outgoing",
        from: AI_DEMO_NEUTRAL_LINE,
        to: "+421910988882",
        hangup_cause: "normal_clearing",
        hangup_source: "callee",
      },
    },
  };
}

describe("the AI demo branch in processTelnyxEvent", () => {
  it("routes a demo leg to the demo handler and acknowledges it", async () => {
    const h = createTelephonyHarness();
    seedDemoLine(h);
    const deps = demoDeps(h);
    const { attempt } = await startAiDemo(deps, { actorProfileId: PROFILES.o5, requestId: null, to: "+421910988882" });
    await transitionAttempt(deps.admin, attempt.id, ["sip_dialing"], { state: "ai_accepted", telnyx_sip_call_control_id: "cc-sip" });

    const result = await processTelnyxEvent(deps, envelope({
      type: "call.answered",
      clientState: aiDemoClientState(attempt.id, "sip"),
      callControlId: "cc-sip",
      eventId: "evt-demo-1",
    }));

    expect(result.status).toBe(200);
    expect(result.outcome).toBe("processed");
    expect(result.notes[0]).toBe("ai_demo:mobile_dialed");
    // No dispatch session was created for the demo.
    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
    expect((await loadAttempt(deps.admin, ORG, attempt.id))?.state).toBe("mobile_dialing");
  });

  it("marks the webhook processed in the ledger, so it is not replayed", async () => {
    const h = createTelephonyHarness();
    seedDemoLine(h);
    const deps = demoDeps(h);
    const { attempt } = await startAiDemo(deps, { actorProfileId: PROFILES.o5, requestId: null, to: "+421910988882" });

    await processTelnyxEvent(deps, envelope({
      type: "call.initiated",
      clientState: aiDemoClientState(attempt.id, "sip"),
      callControlId: "cc-sip",
      eventId: "evt-demo-2",
    }));

    const ledger = h.rows("motorist_telnyx_webhook_events").find((row) => row.event_id === "evt-demo-2");
    expect(ledger?.status).toBe("processed");
  });

  it("answers 200 and ignores a demo leg whose attempt is gone", async () => {
    const h = createTelephonyHarness();
    seedDemoLine(h);
    const deps = demoDeps(h);

    const result = await processTelnyxEvent(deps, envelope({
      type: "call.hangup",
      clientState: aiDemoClientState("99999999-9999-4999-8999-999999999999", "mobile"),
      callControlId: "cc-ghost",
      eventId: "evt-demo-3",
    }));

    expect(result.status).toBe(200);
    expect(result.outcome).toBe("ignored");
    expect(result.notes[0]).toBe("ai_demo:unknown_attempt");
  });

  it("leaves an ordinary inbound call on the human path", async () => {
    const h = createTelephonyHarness();
    seedDemoLine(h);

    // The same harness scenario the existing inbound tests use: no demo
    // client_state, so the branch must not see it.
    const result = await processTelnyxEvent(h.deps, {
      data: {
        record_type: "event",
        event_type: "call.initiated",
        id: "evt-human-1",
        occurred_at: "2026-09-03T08:00:00.000Z",
        payload: {
          call_control_id: "cc-human",
          call_leg_id: "leg-human",
          call_session_id: "telnyx-session-human",
          connection_id: CONNECTION_ID,
          client_state: null,
          direction: "incoming",
          from: "+421905123456",
          to: "+421232408700",
        },
      },
    });

    expect(result.notes.some((note) => note.startsWith("ai_demo:"))).toBe(false);
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
    expect(h.rows("motorist_ai_demo_attempts")).toHaveLength(0);
  });

  it("ignores a client_state that only looks like ours", async () => {
    const h = createTelephonyHarness();
    seedDemoLine(h);
    const forged = Buffer.from(JSON.stringify({ s: "not-a-uuid", r: "external", i: "ai_demo:sip" }), "utf8").toString("base64");

    const result = await processTelnyxEvent(h.deps, envelope({
      type: "call.answered",
      clientState: forged,
      callControlId: "cc-forged",
      eventId: "evt-demo-4",
    }));

    // `decodeClientState` refuses the value outright, so the event falls
    // through to the ordinary correlation path rather than into the demo.
    expect(result.notes.some((note) => note.startsWith("ai_demo:"))).toBe(false);
  });
});
