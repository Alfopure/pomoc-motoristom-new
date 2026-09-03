import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";
import { SmsWorkflowError } from "@/server/sms-workflow";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";

import { createTelnyxSmsTransport, mapTelnyxSendStatus, resetSmsRateLimit } from "./sms-client";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

const ENV = {
  TELNYX_API_KEY: "KEYtest",
  TELNYX_API_BASE_URL: "https://api.telnyx.test/v2",
  TELNYX_MESSAGING_PROFILE_ID: "profile-1",
  TELNYX_SMS_ALPHA_SENDER: "PomocMotor",
  TELNYX_SMS_LIVE_SENDS: "true",
};

function harness(options: { env?: Record<string, string | undefined>; smsLiveSends?: boolean; destinationAllowlist?: string[] } = {}) {
  const supabase = createFakeSupabase();
  supabase.db.seed("motorist_telephony_settings", [
    { organization_id: ORGANIZATION_ID, live_calls_enabled: true, sms_live_sends: options.smsLiveSends ?? true, destination_allowlist: options.destinationAllowlist ?? ["SK", "CZ"] },
  ]);
  const fetchMock = vi.fn();
  const transport = createTelnyxSmsTransport({
    admin: supabase.admin,
    config: getTelnyxConfig({ ...ENV, ...options.env }),
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { supabase, fetchMock, transport };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ACCEPTED = { data: { id: "msg-1", to: [{ phone_number: "+421905123456", status: "queued" }] } };

describe("telnyx sms transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSmsRateLimit();
  });

  it("posts the alpha sender, recipient, text and messaging profile", async () => {
    const { fetchMock, transport } = harness();
    fetchMock.mockResolvedValue(jsonResponse(ACCEPTED));

    const result = await transport.send({
      to: "+421905123456",
      body: "Ahoj",
      idempotencyKey: "case:1:sms:eta_update",
      organizationId: ORGANIZATION_ID,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.test/v2/messages");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "PomocMotor",
      to: "+421905123456",
      text: "Ahoj",
      messaging_profile_id: "profile-1",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer KEYtest");
    expect(headers["idempotency-key"]).toBe("case:1:sms:eta_update");
    expect(result).toEqual({
      providerMessageId: "msg-1",
      status: "queued",
      providerStatus: "queued",
      fromSender: "PomocMotor",
      messagingProfileId: "profile-1",
    });
  });

  it("refuses without touching the network when the DB kill switch is off", async () => {
    const { fetchMock, transport } = harness({ smsLiveSends: false });

    const failure = await transport
      .send({ to: "+421905123456", body: "Ahoj", idempotencyKey: "k", organizationId: ORGANIZATION_ID })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmsWorkflowError);
    expect((failure as SmsWorkflowError).status).toBe(423);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the environment switch is off", async () => {
    const { fetchMock, transport } = harness({ env: { TELNYX_SMS_LIVE_SENDS: "false" } });

    const failure = await transport.preflight({ organizationId: ORGANIZATION_ID }).catch((error: unknown) => error);

    expect((failure as SmsWorkflowError).status).toBe(423);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the organisation has no settings row", async () => {
    const { fetchMock, transport } = harness();

    const failure = await transport
      .send({ to: "+421905123456", body: "Ahoj", idempotencyKey: "k", organizationId: "22222222-2222-4222-8222-222222222222" })
      .catch((error: unknown) => error);

    expect((failure as SmsWorkflowError).status).toBe(423);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing API key as not configured", async () => {
    const { fetchMock, transport } = harness({ env: { TELNYX_API_KEY: undefined } });

    const failure = await transport
      .send({ to: "+421905123456", body: "Ahoj", idempotencyKey: "k", organizationId: ORGANIZATION_ID })
      .catch((error: unknown) => error);

    expect((failure as SmsWorkflowError).status).toBe(503);
    expect((failure as SmsWorkflowError).message).toContain("SMS nie je nakonfigurované");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a provider rejection to a 400 workflow error", async () => {
    const { fetchMock, transport } = harness();
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ code: "10015", title: "Invalid number", detail: "to is not a valid number" }] }, 422));

    const failure = await transport
      .send({ to: "+421905123456", body: "Ahoj", idempotencyKey: "k", organizationId: ORGANIZATION_ID })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmsWorkflowError);
    expect((failure as SmsWorkflowError).status).toBe(400);
    expect((failure as SmsWorkflowError).message).toContain("to is not a valid number");
  });

  it("maps a provider outage to a 502 workflow error", async () => {
    const { fetchMock, transport } = harness();
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ code: "20000", detail: "internal" }] }, 503));

    const failure = await transport
      .send({ to: "+421905123456", body: "Ahoj", idempotencyKey: "k", organizationId: ORGANIZATION_ID })
      .catch((error: unknown) => error);

    expect((failure as SmsWorkflowError).status).toBe(502);
  });

  it("refuses a recipient outside the destination allowlist without calling Telnyx", async () => {
    const { fetchMock, transport } = harness({ destinationAllowlist: ["SK"] });

    const failure = await transport
      .send({ to: "+18005550100", body: "Ahoj", idempotencyKey: "case:1:sms:eta_update", organizationId: ORGANIZATION_ID })
      .then(() => null)
      .catch((error: unknown) => error);

    expect((failure as SmsWorkflowError).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an allowlisted-out recipient and an exhausted rate limit already in preflight", async () => {
    const { fetchMock, transport } = harness({ destinationAllowlist: ["SK"] });

    // The workflow writes its audit rows between preflight and send, so both
    // guards must already refuse here.
    const blocked = await transport.preflight({ organizationId: ORGANIZATION_ID, to: "+18005550100" }).catch((error: unknown) => error);
    expect((blocked as SmsWorkflowError).status).toBe(403);
    await expect(transport.preflight({ organizationId: ORGANIZATION_ID, to: "+421905123456" })).resolves.toBeUndefined();

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(ACCEPTED)));
    for (let index = 0; index < 20; index += 1) {
      await transport.send({ to: "+421905123456", body: "Ahoj", idempotencyKey: `k-${index}`, organizationId: ORGANIZATION_ID });
    }
    const limited = await transport.preflight({ organizationId: ORGANIZATION_ID, to: "+421905123456" }).catch((error: unknown) => error);
    expect((limited as SmsWorkflowError).status).toBe(429);
    // Preflight only peeks: the 20 sends are what consumed the window.
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("maps a response without a message id to a 502 workflow error", async () => {
    const { fetchMock, transport } = harness();
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));

    const failure = await transport
      .send({ to: "+421905123456", body: "Ahoj", idempotencyKey: "k", organizationId: ORGANIZATION_ID })
      .catch((error: unknown) => error);

    expect((failure as SmsWorkflowError).status).toBe(502);
  });

  it("maps provider statuses onto the three transport states", () => {
    expect(mapTelnyxSendStatus("queued")).toBe("queued");
    expect(mapTelnyxSendStatus("sending")).toBe("queued");
    expect(mapTelnyxSendStatus("sent")).toBe("sent");
    expect(mapTelnyxSendStatus("delivered")).toBe("sent");
    expect(mapTelnyxSendStatus("sending_failed")).toBe("failed");
    expect(mapTelnyxSendStatus("delivery_failed")).toBe("failed");
    expect(mapTelnyxSendStatus(null)).toBe("queued");
    expect(mapTelnyxSendStatus("čosi_nové")).toBe("queued");
  });
});
