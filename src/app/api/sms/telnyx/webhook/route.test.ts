import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { telnyxSignedMessage } from "@/server/telephony/telnyx/signature";

const applyTelnyxMessageStatus = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ marker: "admin" }) }));

vi.mock("@/server/telephony/telnyx/sms-status", () => ({
  applyTelnyxMessageStatus: (...args: unknown[]) => applyTelnyxMessageStatus(...args),
}));

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, telephonyLogger: vi.fn() };
});

import { POST } from "./route";

const SPKI_PREFIX_LENGTH = 12;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const portalKey = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI_PREFIX_LENGTH).toString("base64");

const ENVELOPE = { data: { event_type: "message.finalized", id: "evt-1", payload: { id: "msg-1", to: [{ status: "delivered" }] } } };

function signedRequest(body: string, signWith = privateKey) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, telnyxSignedMessage(timestamp, body), signWith).toString("base64");
  return new Request("https://app.test/api/sms/telnyx/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp },
    body,
  });
}

describe("POST /api/sms/telnyx/webhook", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    process.env.TELNYX_PUBLIC_KEY = portalKey;
    applyTelnyxMessageStatus.mockReset();
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_PUBLIC_KEY;
  });

  it("returns 503 when telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(503);
    expect(applyTelnyxMessageStatus).not.toHaveBeenCalled();
  });

  it("rejects an unsigned body with 400", async () => {
    const response = await POST(
      new Request("https://app.test/api/sms/telnyx/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ENVELOPE) }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_signature", reason: "missing_signature" });
    expect(applyTelnyxMessageStatus).not.toHaveBeenCalled();
  });

  it("rejects a body signed with a foreign key", async () => {
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE), generateKeyPairSync("ed25519").privateKey));

    expect(response.status).toBe(400);
    expect(applyTelnyxMessageStatus).not.toHaveBeenCalled();
  });

  it("applies the delivery status of a verified event", async () => {
    applyTelnyxMessageStatus.mockResolvedValue({ outcome: "updated", providerMessageId: "msg-1", status: "delivered", detail: "delivered", smsMessageId: "sms-1" });
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "updated", status: "delivered" });
    expect(applyTelnyxMessageStatus).toHaveBeenCalledWith({ marker: "admin" }, ENVELOPE);
  });

  it("acknowledges a status for an unknown message", async () => {
    applyTelnyxMessageStatus.mockResolvedValue({ outcome: "unknown_message", providerMessageId: "msg-x", status: "delivered", detail: null, smsMessageId: null });
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "unknown_message" });
  });

  it("returns 500 when the status update itself fails", async () => {
    applyTelnyxMessageStatus.mockRejectedValue(new Error("supabase down"));
    const response = await POST(signedRequest(JSON.stringify(ENVELOPE)));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "processing_failed" });
  });
});
