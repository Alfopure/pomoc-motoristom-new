import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openaiSignedRequest } from "@/test/fake-openai-live";

const handleOpenAIIncoming = vi.fn();

vi.mock("@/server/telephony/ai-demo/openai-events", () => ({
  handleOpenAIIncoming: (...args: unknown[]) => handleOpenAIIncoming(...args),
}));

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: vi.fn(async () => ({ marker: "deps" })), telephonyLogger: vi.fn() };
});

import { POST } from "./route";

const SECRET = "whsec_c2VjcmV0LWtleS1mb3ItdGVzdA==";
const PAYLOAD = { type: "live.transport.incoming", id: "evt_1", data: { session_id: "live_1", type: "sip", sip_headers: [] } };

const ENV = {
  AI_DEMO_ENABLED: "true",
  AI_DEMO_ALLOWED_RECIPIENTS: "+421910988882",
  OPENAI_API_KEY: "sk-proj-test",
  OPENAI_LIVE_PROJECT_ID: "proj_test",
  OPENAI_WEBHOOK_SECRET: SECRET,
};

describe("POST /api/telephony/webhooks/openai", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
    handleOpenAIIncoming.mockReset();
    handleOpenAIIncoming.mockResolvedValue({ outcome: "accepted", attemptId: "a-1" });
  });

  afterEach(() => {
    for (const key of Object.keys(ENV)) delete process.env[key as keyof typeof ENV];
  });

  it("accepts a correctly signed incoming and hands it to the handler", async () => {
    const response = await POST(openaiSignedRequest({ secret: SECRET, payload: PAYLOAD }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "accepted" });
    expect(handleOpenAIIncoming).toHaveBeenCalledTimes(1);
  });

  it("does no work at all when the demo is switched off", async () => {
    delete process.env.AI_DEMO_ENABLED;

    const response = await POST(openaiSignedRequest({ secret: SECRET, payload: PAYLOAD }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, outcome: "disabled" });
    expect(handleOpenAIIncoming).not.toHaveBeenCalled();
  });

  it("refuses an unsigned delivery", async () => {
    const response = await POST(
      new Request("https://app.test/api/telephony/webhooks/openai", { method: "POST", body: JSON.stringify(PAYLOAD) }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "missing_headers" });
    expect(handleOpenAIIncoming).not.toHaveBeenCalled();
  });

  it("refuses a tampered signature", async () => {
    const response = await POST(openaiSignedRequest({ secret: SECRET, payload: PAYLOAD, tamper: true }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "signature_mismatch" });
    expect(handleOpenAIIncoming).not.toHaveBeenCalled();
  });

  it("refuses a replayed delivery from outside the timestamp window", async () => {
    const response = await POST(
      openaiSignedRequest({ secret: SECRET, payload: PAYLOAD, timestamp: Math.floor(Date.now() / 1000) - 3_600 }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "timestamp_out_of_window" });
  });

  it("refuses a body signed with a different secret", async () => {
    const response = await POST(openaiSignedRequest({ secret: "whsec_b3RoZXI=", payload: PAYLOAD }));
    expect(response.status).toBe(401);
    expect(handleOpenAIIncoming).not.toHaveBeenCalled();
  });

  it("acknowledges rather than asking the provider to retry when it is not configured", async () => {
    // A missing signing secret does not heal itself, so 503 would buy 72 hours
    // of retries and no progress — and the endpoint cannot even be registered,
    // because the secret is only issued once registration succeeds.
    delete process.env.OPENAI_WEBHOOK_SECRET;
    const response = await POST(openaiSignedRequest({ secret: SECRET, payload: PAYLOAD }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe("not_configured");
    // Naming what is missing is the difference between acknowledged and ignored.
    expect(body.missing).toContain("OPENAI_WEBHOOK_SECRET");
    // Acknowledged is not accepted: nothing was acted on.
    expect(handleOpenAIIncoming).not.toHaveBeenCalled();
  });

  it("acknowledges an ignored event, because it is not ours to reject", async () => {
    handleOpenAIIncoming.mockResolvedValue({ outcome: "ignored", reason: "no_pending" });
    const response = await POST(openaiSignedRequest({ secret: SECRET, payload: PAYLOAD }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored", reason: "no_pending" });
  });

  it("acknowledges a recorded failure rather than inviting a redelivery", async () => {
    handleOpenAIIncoming.mockResolvedValue({ outcome: "failed", attemptId: "a-1", code: "accept_failed" });
    const response = await POST(openaiSignedRequest({ secret: SECRET, payload: PAYLOAD }));
    expect(response.status).toBe(200);
  });

  it("asks for a redelivery when the handler itself threw", async () => {
    handleOpenAIIncoming.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(openaiSignedRequest({ secret: SECRET, payload: PAYLOAD }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "processing_failed" });
  });

  it("never leaks the reason a handler failed", async () => {
    handleOpenAIIncoming.mockRejectedValue(new Error("postgres://user:secret@host/db"));
    const response = await POST(openaiSignedRequest({ secret: SECRET, payload: PAYLOAD }));
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("secret@host");
  });

  it("refuses an oversized body before parsing it", async () => {
    const response = await POST(openaiSignedRequest({ secret: SECRET, payload: { type: "live.transport.incoming", pad: "x".repeat(70_000) } }));
    expect(response.status).toBe(413);
    expect(handleOpenAIIncoming).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed body that is not JSON", async () => {
    const raw = "definitely not json";
    const id = "evt_raw";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${timestamp}.${raw}`, "utf8").digest("base64");
    const request = new Request("https://app.test/api/telephony/webhooks/openai", {
      method: "POST",
      headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${digest}` },
      body: raw,
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    expect(handleOpenAIIncoming).not.toHaveBeenCalled();
  });
});
