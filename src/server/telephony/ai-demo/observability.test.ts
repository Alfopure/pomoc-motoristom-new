import { describe, expect, it } from "vitest";

import { createFakeOpenAIFetch, createFakeSideband } from "@/test/fake-openai-live";
import { createTelephonyHarness, CONNECTION_ID, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { processTelnyxEvent } from "../telnyx/event-processor";
import { AI_DEMO_NEUTRAL_LINE } from "./config";
import { aiDemoClientState } from "./identity";
import { handleOpenAIIncoming } from "./openai-events";
import { describeAttempt, loadAttempt, startAiDemo, type AiDemoDeps } from "./orchestrator";

/**
 * What a demo call leaves behind, and what it must never leave behind.
 *
 * Two questions, both answered here rather than by reading the code. Can
 * somebody reconstruct a call afterwards from the logs and the row? And does
 * either of them contain a key, a whole phone number, or a word anybody said?
 *
 * The second matters more than it looks: the demo touches an API key, a webhook
 * secret, a project id, a customer's number and the contents of a telephone
 * conversation. Every one of those has an obvious path into a log line.
 */

const ENV = {
  AI_DEMO_ENABLED: "true",
  AI_DEMO_ALLOWED_RECIPIENTS: "+421910988882",
  OPENAI_API_KEY: "sk-proj-super-secret-key-value",
  OPENAI_LIVE_PROJECT_ID: "proj_secret123",
  OPENAI_WEBHOOK_SECRET: "whsec_c2VjcmV0",
};

const TARGET = "+421910988882";
const CONTEXT = "Pán Novák, Škoda Octavia, náhradné vozidlo Fabia";
const FAST_PROBE = { probeOpenMs: 80, probeAppendedMs: 80, probeFirstDeltaMs: 120, probeWindowMs: 250, probeMaxEvents: 20, backchannelMaxMs: 20, keepTranscript: true, probeCheckpointMs: 1_000 };

/** Anything whose appearance in a log line would be a leak. */
const SECRETS = [
  ENV.OPENAI_API_KEY,
  ENV.OPENAI_WEBHOOK_SECRET,
  ENV.OPENAI_LIVE_PROJECT_ID,
  "sk-proj",
  "whsec_",
  "Bearer ",
  TARGET,
  "910988882",
  // The conversation itself, and the brief that shaped it.
  "Dobrý deň, tu je Veronika",
  "Novák",
];

function seedDemoLine(h: TelephonyHarness) {
  h.db.seed("motorist_telephony_lines", [
    {
      id: "00000000-0000-4000-8000-000000000208", organization_id: ORG, provider: "telnyx", phone_number: AI_DEMO_NEUTRAL_LINE,
      label: "Neutrálna linka 2", partner_name: null, ring_plan_id: null, ivr_menu_id: null, business_hours_id: null,
      environment: "production", active: true, telnyx_number_id: "3043592669122004035", external_id: null, metadata: {},
    },
  ]);
}

function envelope(options: { type: string; attemptId: string; leg: "sip" | "mobile"; eventId: string; hangupCause?: string }) {
  return {
    data: {
      record_type: "event",
      event_type: options.type,
      id: options.eventId,
      occurred_at: new Date().toISOString(),
      payload: {
        call_control_id: options.leg === "sip" ? "cc-sip" : "cc-mobile",
        call_leg_id: `leg-${options.leg}`,
        call_session_id: "telnyx-session-obs",
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

async function runWholeCall() {
  const h = createTelephonyHarness();
  seedDemoLine(h);
  const logs: Array<Record<string, unknown>> = [];
  const deferred: Array<() => Promise<void>> = [];
  const sideband = createFakeSideband({
    onInstructions: [
      { delayMs: 5, event: { type: "session.instructions.appended" } },
      { delayMs: 20, event: { type: "session.output_transcript.delta", delta: "Dobrý deň, tu je Veronika" } },
      { delayMs: 90, event: { type: "session.input_transcript.delta", delta: "áno, počúvam" } },
    ],
  });

  const deps: AiDemoDeps = {
    ...h.deps,
    env: ENV,
    openAIFetch: createFakeOpenAIFetch().fetch,
    telnyxClientFactory: () => h.telnyx.client,
    webSocketFactory: sideband.factory,
    probeLimits: FAST_PROBE,
    deferMaintenance: (work) => void deferred.push(work),
    logger: (entry) => logs.push(entry),
  };
  const drain = async () => {
    while (deferred.length > 0) await deferred.shift()!();
  };

  const { attempt } = await startAiDemo(deps, { actorProfileId: PROFILES.o5, requestId: null, to: TARGET, context: CONTEXT });
  await processTelnyxEvent(deps, envelope({ type: "call.initiated", attemptId: attempt.id, leg: "sip", eventId: "o1" }));
  await handleOpenAIIncoming(deps, { type: "live.transport.incoming", data: { session_id: "live_obs", type: "sip", sip_headers: [] } });
  await processTelnyxEvent(deps, envelope({ type: "call.answered", attemptId: attempt.id, leg: "sip", eventId: "o2" }));
  await processTelnyxEvent(deps, envelope({ type: "call.answered", attemptId: attempt.id, leg: "mobile", eventId: "o3" }));
  await drain();
  await processTelnyxEvent(deps, envelope({ type: "call.hangup", attemptId: attempt.id, leg: "mobile", eventId: "o4", hangupCause: "normal_clearing" }));
  await drain();

  return { h, deps, logs, attemptId: attempt.id };
}

describe("what the logs may contain", () => {
  it("carries no key, no whole number and no word anybody said", async () => {
    const { logs } = await runWholeCall();
    const text = JSON.stringify(logs);

    for (const secret of SECRETS) {
      expect(text, `logs leaked: ${secret}`).not.toContain(secret);
    }
  });

  it("still says enough to reconstruct the call", async () => {
    const { logs, attemptId } = await runWholeCall();
    const demo = logs.filter((entry) => entry.scope === "ai-demo");

    // Not "something happened": which attempt, and what was measured.
    expect(demo.length).toBeGreaterThan(0);
    expect(demo.some((entry) => entry.attemptId === attemptId)).toBe(true);
    expect(demo.some((entry) => entry.message === "greeting probe")).toBe(true);
  });
});

describe("what the stored row may contain", () => {
  it("keeps the measurements and the brief, but never a key", async () => {
    const { deps, attemptId } = await runWholeCall();
    const row = await loadAttempt(deps.admin, ORG, attemptId);
    const text = JSON.stringify(row);

    for (const secret of [ENV.OPENAI_API_KEY, ENV.OPENAI_WEBHOOK_SECRET, "sk-proj", "whsec_", "Bearer "]) {
      expect(text, `row leaked: ${secret}`).not.toContain(secret);
    }
    // The brief and the target are the demo's own record and belong here.
    expect(text).toContain("Novák");
    expect(row?.target_number).toBe(TARGET);
  });
});

describe("what the API hands back", () => {
  it("masks the number and withholds the transcript unless it is asked for", async () => {
    const { deps, attemptId } = await runWholeCall();
    const row = await loadAttempt(deps.admin, ORG, attemptId);
    const listed = describeAttempt(row!);

    expect(JSON.stringify(listed)).not.toContain("910988882");
    expect(listed.targetMasked).toBe("+421910•••882");
    // The words travel only on an explicit request for one attempt.
    expect(listed).not.toHaveProperty("transcript");
    expect(listed.hasTranscript).toBe(true);

    const opened = describeAttempt(row!, { includeTranscript: true });
    expect(JSON.stringify(opened)).toContain("Veronika");
  });

  it("never exposes the prompt it was given", async () => {
    const { deps, attemptId } = await runWholeCall();
    const row = await loadAttempt(deps.admin, ORG, attemptId);
    const described = JSON.stringify(describeAttempt(row!, { includeTranscript: true }));

    // The brief is the operator's own text and is fine; the assembled prompt is
    // not something the browser has any business seeing.
    expect(described).not.toContain("Si Veronika, pokojná");
    expect(described).not.toContain("Postup hovoru");
  });
});
