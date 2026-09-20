import { beforeEach, describe, expect, it } from "vitest";

import { createFakeOpenAIFetch } from "@/test/fake-openai-live";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { loadAttempt, transitionAttempt, type AiDemoAttempt } from "./attempts";
import { AI_DEMO_NEUTRAL_LINE } from "./config";
import { handleOpenAIIncoming } from "./openai-events";
import { startAiDemo, type AiDemoDeps } from "./orchestrator";

const ENV = {
  AI_DEMO_ENABLED: "true",
  AI_DEMO_ALLOWED_RECIPIENTS: "+421910988882",
  OPENAI_API_KEY: "sk-proj-test",
  OPENAI_LIVE_PROJECT_ID: "proj_test123",
  OPENAI_WEBHOOK_SECRET: "whsec_c2VjcmV0",
};

type Fixture = { h: TelephonyHarness; deps: AiDemoDeps; attempt: AiDemoAttempt; openai: ReturnType<typeof createFakeOpenAIFetch> };

async function fixture(openaiOptions: Parameters<typeof createFakeOpenAIFetch>[0] = {}): Promise<Fixture> {
  const h = createTelephonyHarness();
  h.db.seed("motorist_telephony_lines", [
    {
      id: "00000000-0000-4000-8000-000000000208", organization_id: ORG, provider: "telnyx", phone_number: AI_DEMO_NEUTRAL_LINE,
      label: "Neutrálna linka 2", partner_name: null, ring_plan_id: null, ivr_menu_id: null, business_hours_id: null,
      environment: "production", active: true, telnyx_number_id: "3043592669122004035", external_id: null, metadata: {},
    },
  ]);
  const openai = createFakeOpenAIFetch(openaiOptions);
  const deps: AiDemoDeps = { ...h.deps, env: ENV, openAIFetch: openai.fetch, telnyxClientFactory: () => h.telnyx.client };
  const { attempt } = await startAiDemo(deps, { actorProfileId: PROFILES.o5, requestId: null, to: "+421910988882", context: "Pán Novák, Škoda Octavia" });
  return { h, deps, attempt, openai };
}

function incoming(sessionId = "live_session_1", fromHeader?: string) {
  return {
    type: "live.transport.incoming",
    id: "evt_1",
    created_at: 1_772_000_000,
    data: {
      session_id: sessionId,
      type: "sip",
      sip_headers: fromHeader ? [{ name: "From", value: fromHeader }] : [],
    },
  };
}

describe("handleOpenAIIncoming", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it("accepts the session and records it against the attempt", async () => {
    const result = await handleOpenAIIncoming(f.deps, incoming());

    expect(result).toEqual({ outcome: "accepted", attemptId: f.attempt.id });
    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.state).toBe("ai_accepted");
    expect(row?.openai_session_id).toBe("live_session_1");
    expect(row?.ai_offered_at).not.toBeNull();
    expect(row?.ai_accepted_at).not.toBeNull();
  });

  it("delivers the whole persona in the accept body, while the phone is still silent", async () => {
    await handleOpenAIIncoming(f.deps, incoming());

    const accept = f.openai.calls.find((call) => call.url.includes("/accept"));
    const session = (accept?.body as { session: Record<string, unknown> }).session;
    expect(String(session.instructions)).toContain("Veronika");
    expect(String(session.instructions)).toContain("Hovor po slovensky");
    // The admin's context travels with the accept, not over the sideband later.
    expect(String(session.instructions)).toContain("Pán Novák, Škoda Octavia");
    const delegation = session.delegation as { responses: Record<string, unknown> };
    expect(delegation.responses.reasoning).toEqual({ effort: "none" });
    expect(delegation.responses.service_tier).toBe("ultrafast");
  });

  it("does not accept the same session twice", async () => {
    await handleOpenAIIncoming(f.deps, incoming());
    const result = await handleOpenAIIncoming(f.deps, incoming());

    expect(result).toEqual({ outcome: "already_running", attemptId: f.attempt.id });
    expect(f.openai.calls.filter((call) => call.url.includes("/accept"))).toHaveLength(1);
  });

  it("ignores an incoming that matches no attempt of ours, and never rejects it", async () => {
    await transitionAttempt(f.deps.admin, f.attempt.id, ["sip_dialing"], { state: "ended" });

    const result = await handleOpenAIIncoming(f.deps, incoming("live_stranger"));

    expect(result).toEqual({ outcome: "ignored", reason: "no_pending" });
    // A SIP 603 would mean answering for somebody else's call.
    expect(f.openai.calls.filter((call) => call.url.includes("/reject"))).toHaveLength(0);
  });

  it("ignores an incoming whose From carries another attempt's token", async () => {
    const result = await handleOpenAIIncoming(f.deps, incoming("live_x", '"PM-AI-DEMO-deadbeef" <sip:+421232408774@x>'));
    expect(result).toEqual({ outcome: "ignored", reason: "from_mismatch" });
    expect(f.openai.calls.filter((call) => call.url.includes("/accept"))).toHaveLength(0);
  });

  it("ignores an event type it does not handle", async () => {
    await expect(handleOpenAIIncoming(f.deps, { type: "realtime.call.incoming", data: { call_id: "rtc_1" } })).resolves.toEqual({
      outcome: "ignored",
      reason: "unsupported_event",
    });
  });
});

describe("a failed accept", () => {
  it("ends the attempt and releases both sides", async () => {
    const f = await fixture({ acceptStatus: 403 });

    const result = await handleOpenAIIncoming(f.deps, incoming());

    expect(result).toMatchObject({ outcome: "failed" });
    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.state).toBe("failed");
    expect(row?.error_code).toBe("accept_failed");
    // The customer's phone was never dialled, so nobody was disturbed.
    expect(f.h.telnyx.of("dial").filter((call) => call.params.to === "+421910988882")).toHaveLength(0);
  });

  it("records an auth failure distinctly, because retrying cannot help", async () => {
    const f = await fixture({ acceptStatus: 401, acceptRetryStatus: 401 });
    await handleOpenAIIncoming(f.deps, incoming());
    const row = await loadAttempt(f.deps.admin, ORG, f.attempt.id);
    expect(row?.end_reason).toBe("openai_accept_401");
  });
});

describe("a session already decided", () => {
  it("counts as accepted so a redelivered webhook is a no-op", async () => {
    const f = await fixture({ acceptStatus: 409, acceptBody: JSON.stringify({ error: { code: "decision_already_made" } }) });

    const result = await handleOpenAIIncoming(f.deps, incoming());

    expect(result).toMatchObject({ outcome: "accepted" });
    expect((await loadAttempt(f.deps.admin, ORG, f.attempt.id))?.state).toBe("ai_accepted");
  });
});
