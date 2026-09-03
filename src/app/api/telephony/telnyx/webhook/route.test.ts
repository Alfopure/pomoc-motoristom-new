import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { telnyxSignedMessage } from "@/server/telephony/telnyx/signature";

const processTelnyxEvent = vi.fn();

vi.mock("@/server/telephony/telnyx/event-processor", () => ({
  processTelnyxEvent: (...args: unknown[]) => processTelnyxEvent(...args),
}));

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: vi.fn(async () => ({ marker: "deps" })), telephonyLogger: vi.fn() };
});

import { POST } from "./route";

const SPKI_PREFIX_LENGTH = 12;

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, portalKey: spki.subarray(SPKI_PREFIX_LENGTH).toString("base64") };
}

const keys = makeKeys();

function signedRequest(body: string, options: { privateKey?: KeyObject; timestamp?: string } = {}) {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = sign(null, telnyxSignedMessage(timestamp, body), options.privateKey ?? keys.privateKey).toString("base64");
  return new Request("https://app.test/api/telephony/telnyx/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp },
    body,
  });
}

const ENVELOPE = { data: { record_type: "event", event_type: "call.initiated", id: "evt-1", payload: { call_control_id: "cc-1" } } };

function processorResult(overrides: Record<string, unknown> = {}) {
  return { status: 200, outcome: "processed", eventId: "evt-1", type: "call.initiated", sessionId: "sess-1", commands: [{ kind: "answer", ok: true, error: null }], notes: [], error: null, ms: 3, ...overrides };
}

describe("POST /api/telephony/telnyx/webhook", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    process.env.TELNYX_PUBLIC_KEY = keys.portalKey;
    processTelnyxEvent.mockReset();
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_PUBLIC_KEY;
  });

  it("returns 503 with the Slovak notice when telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Telefónia nie je nakonfigurovaná." });
    expect(processTelnyxEvent).not.toHaveBeenCalled();
  });

  it("returns 503 when the signing key is missing (nothing can be verified)", async () => {
    delete process.env.TELNYX_PUBLIC_KEY;
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(503);
    expect(processTelnyxEvent).not.toHaveBeenCalled();
  });

  it("rejects a body signed with a foreign key before any processing", async () => {
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE), { privateKey: makeKeys().privateKey }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_signature", reason: "invalid_signature" });
    expect(processTelnyxEvent).not.toHaveBeenCalled();
  });

  it("rejects an expired timestamp", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3_600);
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE), { timestamp: stale }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "timestamp_out_of_tolerance" });
  });

  it("rejects a correctly signed body that is not JSON", async () => {
    const response = await POST(signedRequest("not json"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    expect(processTelnyxEvent).not.toHaveBeenCalled();
  });

  it("hands a verified event to the processor and mirrors its status", async () => {
    processTelnyxEvent.mockResolvedValue(processorResult());
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "processed", eventId: "evt-1", sessionId: "sess-1", commands: ["answer"] });
    expect(processTelnyxEvent).toHaveBeenCalledWith({ marker: "deps" }, ENVELOPE);
  });

  it("acknowledges an event from a foreign connection with 200", async () => {
    processTelnyxEvent.mockResolvedValue(processorResult({ outcome: "unverified_connection", sessionId: null, commands: [] }));
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "unverified_connection" });
  });

  it("passes a bookkeeping failure through as 500 so Telnyx retries", async () => {
    processTelnyxEvent.mockResolvedValue(processorResult({ status: 500, outcome: "failed", error: "boom" }));
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "failed" });
  });

  it("never leaks an unexpected processor exception", async () => {
    processTelnyxEvent.mockRejectedValue(new Error("supabase down"));
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "processing_failed" });
  });
});
