import { describe, expect, it } from "vitest";

import { createFakeOpenAIFetch } from "@/test/fake-openai-live";
import { createHmac } from "node:crypto";

import { openAILiveClient, OpenAILiveError, parseLiveIncoming, verifyOpenAIWebhook } from "./openai-live";

const ACCEPT = {
  sessionId: "live_abc123",
  model: "gpt-live-1",
  voice: "marin",
  instructions: "Si Veronika.",
  backendModel: "gpt-5.6-terra",
  backendInstructions: "Odpovedaj krátko.",
};

const SECRET = "whsec_c2VjcmV0LWtleS1mb3ItdGVzdA==";

function signed(body: string, options: { id?: string; timestamp?: number; secret?: string } = {}) {
  const id = options.id ?? "evt_1";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const secret = options.secret ?? SECRET;
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
  return new Headers({ "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${digest}` });
}

describe("openAILiveClient.accept", () => {
  it("sends the documented body without audio.format or tools", async () => {
    const fake = createFakeOpenAIFetch();
    const client = openAILiveClient({ apiKey: "sk-test", fetch: fake.fetch });

    const result = await client.accept({ ...ACCEPT, tuning: { reasoningEffort: "none", serviceTier: "ultrafast", maxOutputTokens: 400 } });

    expect(result).toEqual({ status: "accepted", tuningApplied: true });
    const body = fake.calls[0].body as { session: Record<string, unknown> };
    expect(body.session.type).toBe("live");
    expect(body.session.model).toBe("gpt-live-1");
    // SIP negotiates the media format; the field is refused on a SIP session.
    expect(body.session.audio).toEqual({ output: { voice: "marin" } });
    expect(body.session).not.toHaveProperty("tools");
    expect(body.session).not.toHaveProperty("turn_detection");
    const delegation = body.session.delegation as { type: string; responses: Record<string, unknown> };
    expect(delegation.type).toBe("responses");
    expect(delegation.responses.reasoning).toEqual({ effort: "none" });
    expect(delegation.responses.service_tier).toBe("ultrafast");
    expect(delegation.responses).not.toHaveProperty("tools");
  });

  it("retries once without the latency tuning when the request is refused", async () => {
    const fake = createFakeOpenAIFetch({ acceptStatus: 400, acceptRetryStatus: 200 });
    const client = openAILiveClient({ apiKey: "sk-test", fetch: fake.fetch });

    const result = await client.accept({ ...ACCEPT, tuning: { reasoningEffort: "none", serviceTier: "ultrafast" } });

    expect(result).toEqual({ status: "accepted", tuningApplied: false });
    expect(fake.calls).toHaveLength(2);
    const retry = fake.calls[1].body as { session: { delegation: { responses: Record<string, unknown> } } };
    expect(retry.session.delegation.responses).not.toHaveProperty("service_tier");
    expect(retry.session.delegation.responses).not.toHaveProperty("reasoning");
  });

  it("treats decision_already_made as success so a redelivered webhook is a no-op", async () => {
    const fake = createFakeOpenAIFetch({ acceptStatus: 409, acceptBody: JSON.stringify({ error: { code: "decision_already_made" } }) });
    const client = openAILiveClient({ apiKey: "sk-test", fetch: fake.fetch });

    await expect(client.accept(ACCEPT)).resolves.toEqual({ status: "already_decided", tuningApplied: true });
    expect(fake.calls).toHaveLength(1);
  });

  it("does not retry an auth failure and reports it as certain", async () => {
    const fake = createFakeOpenAIFetch({ acceptStatus: 401 });
    const client = openAILiveClient({ apiKey: "sk-test", fetch: fake.fetch });

    await expect(client.accept(ACCEPT)).rejects.toMatchObject({ code: "openai_accept_401", uncertain: false });
    expect(fake.calls).toHaveLength(1);
  });

  it("marks a 429 as uncertain", async () => {
    const fake = createFakeOpenAIFetch({ acceptStatus: 429 });
    const client = openAILiveClient({ apiKey: "sk-test", fetch: fake.fetch });
    await expect(client.accept(ACCEPT)).rejects.toMatchObject({ uncertain: true });
  });

  it("refuses a session id that is not a live session", async () => {
    const fake = createFakeOpenAIFetch();
    const client = openAILiveClient({ apiKey: "sk-test", fetch: fake.fetch });
    await expect(client.accept({ ...ACCEPT, sessionId: "../../etc/passwd" })).rejects.toBeInstanceOf(OpenAILiveError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("openAILiveClient.hangup", () => {
  it("counts a session that is already gone as done", async () => {
    const fake = createFakeOpenAIFetch({ hangupStatus: 404 });
    const client = openAILiveClient({ apiKey: "sk-test", fetch: fake.fetch });
    await expect(client.hangup("live_abc123")).resolves.toEqual({ done: true, status: 404 });
  });

  it("reports a 5xx as unfinished so cleanup can try once more", async () => {
    const fake = createFakeOpenAIFetch({ hangupStatus: 503 });
    const client = openAILiveClient({ apiKey: "sk-test", fetch: fake.fetch });
    await expect(client.hangup("live_abc123")).resolves.toEqual({ done: false, status: 503 });
  });

  it("raises an auth failure rather than pretending the session was released", async () => {
    const fake = createFakeOpenAIFetch({ hangupStatus: 403 });
    const client = openAILiveClient({ apiKey: "sk-test", fetch: fake.fetch });
    await expect(client.hangup("live_abc123")).rejects.toMatchObject({ code: "openai_auth" });
  });
});

describe("parseLiveIncoming", () => {
  it("reads the session id and the From/To headers", () => {
    expect(
      parseLiveIncoming({
        type: "live.transport.incoming",
        data: {
          session_id: "live_xyz",
          type: "sip",
          sip_headers: [
            { name: "From", value: '"PM-AI-DEMO-1a2b3c4d" <sip:+421232408774@example>' },
            { name: "To", value: "<sip:proj_abc@sip.api.openai.com>" },
          ],
        },
      }),
    ).toEqual({ sessionId: "live_xyz", fromHeader: '"PM-AI-DEMO-1a2b3c4d" <sip:+421232408774@example>', toHeader: "<sip:proj_abc@sip.api.openai.com>" });
  });

  it("ignores the deprecated and Realtime siblings", () => {
    expect(parseLiveIncoming({ type: "live.call.incoming", data: { session_id: "live_x", type: "sip" } })).toBeNull();
    expect(parseLiveIncoming({ type: "realtime.call.incoming", data: { call_id: "rtc_x" } })).toBeNull();
  });

  it("ignores a non-SIP transport", () => {
    expect(parseLiveIncoming({ type: "live.transport.incoming", data: { session_id: "live_x", type: "webrtc" } })).toBeNull();
  });
});

describe("verifyOpenAIWebhook", () => {
  const body = JSON.stringify({ type: "live.transport.incoming" });

  it("accepts a correctly signed delivery", () => {
    expect(verifyOpenAIWebhook(signed(body), body, { secret: SECRET })).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const headers = signed(body);
    expect(verifyOpenAIWebhook(headers, `${body} `, { secret: SECRET })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a replay outside the timestamp window", () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    expect(verifyOpenAIWebhook(signed(body, { timestamp: old }), body, { secret: SECRET })).toEqual({ ok: false, reason: "timestamp_out_of_window" });
  });

  it("rejects a signature made with another secret", () => {
    const headers = signed(body, { secret: "whsec_b3RoZXItc2VjcmV0" });
    expect(verifyOpenAIWebhook(headers, body, { secret: SECRET })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a delivery with no signature headers at all", () => {
    expect(verifyOpenAIWebhook(new Headers(), body, { secret: SECRET })).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("accepts when any listed version matches, so a key rotation does not drop events", () => {
    const headers = signed(body);
    const valid = headers.get("webhook-signature")!;
    headers.set("webhook-signature", `v1,AAAA ${valid}`);
    expect(verifyOpenAIWebhook(headers, body, { secret: SECRET })).toEqual({ ok: true });
  });
});
