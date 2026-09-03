import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adminMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: adminMock,
}));

import { normalizeSmsRecipient, notConfiguredTransport, resolveSmsTransport, sendCustomSms, SmsWorkflowError, type SmsTransport } from "./sms-workflow";

type QueryCall = { method: string; args: unknown[] };
type QueryRecorder = { calls: QueryCall[]; query: Record<string, unknown> };

const CHAINED_METHODS = ["select", "insert", "update", "eq", "in", "ilike", "not", "order", "limit", "maybeSingle", "single"] as const;

describe("notConfiguredTransport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects with SmsWorkflowError 503 and never reaches the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must stay untouched"));

    const failure = await notConfiguredTransport
      .send({ to: "+421905123456", body: "Test", idempotencyKey: "case:1:sms:location_request", organizationId: "org-1" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmsWorkflowError);
    expect((failure as SmsWorkflowError).status).toBe(503);
    expect((failure as SmsWorkflowError).message).toContain("SMS nie je nakonfigurované");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sendCustomSms", () => {
  beforeEach(() => adminMock.mockReset());

  it("fails closed before any Supabase access while no transport is configured", async () => {
    const from = vi.fn();
    adminMock.mockReturnValue({ from });

    const failure = await sendCustomSms({
      actorProfileId: "profile-1",
      body: "Ahoj",
      caseId: null,
      organizationId: "org-1",
      toNumber: "0905 123 456",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmsWorkflowError);
    expect((failure as SmsWorkflowError).status).toBe(503);
    expect((failure as SmsWorkflowError).message).toContain("SMS nie je nakonfigurované");
    expect(adminMock).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("persists provider-neutral rows, hands an E.164 recipient to the transport and mirrors the result", async () => {
    const recorders = new Map<string, QueryRecorder[]>();
    const from = vi.fn((table: string) => {
      const recorder = makeQuery(table);
      recorders.set(table, [...(recorders.get(table) ?? []), recorder]);
      return recorder.query;
    });
    adminMock.mockReturnValue({ from });
    const send = vi
      .fn()
      .mockResolvedValue({ providerMessageId: "msg-1", status: "sent", providerStatus: "sent", fromSender: "PomocMotor", messagingProfileId: "profile-1" });
    const transport: SmsTransport = { send };

    const result = await sendCustomSms(
      { actorProfileId: "profile-1", body: "Ahoj", caseId: null, organizationId: "org-1", toNumber: "0905 123 456" },
      { transport },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      body: "Ahoj",
      idempotencyKey: expect.stringMatching(/^custom-sms:profile-1:/),
      organizationId: "org-1",
      to: "+421905123456",
    });

    const [messageInsert, messageUpdate] = recorders.get("motorist_sms_messages") ?? [];
    const [attemptInsert, attemptUpdate] = recorders.get("motorist_sms_attempts") ?? [];
    expect(argOf(messageInsert, "insert")).toMatchObject({
      provider: "telnyx_sms",
      organization_id: "org-1",
      to_number: "+421905123456",
      status: "queued",
      template_key: "custom",
      body: "Ahoj",
    });
    expect(argOf(attemptInsert, "insert")).toMatchObject({ provider: "telnyx_sms", sms_message_id: "sms-1", status: "sending" });
    expect(argOf(attemptUpdate, "update")).toMatchObject({ status: "accepted", provider_message_id: "msg-1" });
    expect(argOf(messageUpdate, "update")).toMatchObject({
      status: "sent",
      status_detail: "sent",
      provider_message_id: "msg-1",
      from_sender: "PomocMotor",
      messaging_profile_id: "profile-1",
      error: null,
    });
    expect(result).toEqual({ providerMessageId: "msg-1", smsMessageId: "sms-1", status: "sent", statusDetail: "sent" });
  });

  it("marks both audit rows failed and propagates the transport error status", async () => {
    const recorders = new Map<string, QueryRecorder[]>();
    const from = vi.fn((table: string) => {
      const recorder = makeQuery(table);
      recorders.set(table, [...(recorders.get(table) ?? []), recorder]);
      return recorder.query;
    });
    adminMock.mockReturnValue({ from });
    const transport: SmsTransport = {
      send: vi.fn().mockRejectedValue(new SmsWorkflowError("Poskytovateľ odmietol správu.", 502)),
    };

    const failure = await sendCustomSms(
      { actorProfileId: "profile-1", body: "Ahoj", caseId: null, organizationId: "org-1", toNumber: "+421 905 123 456" },
      { transport },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmsWorkflowError);
    expect((failure as SmsWorkflowError).status).toBe(502);
    const [, messageUpdate] = recorders.get("motorist_sms_messages") ?? [];
    const [, attemptUpdate] = recorders.get("motorist_sms_attempts") ?? [];
    expect(argOf(attemptUpdate, "update")).toMatchObject({ status: "failed", error: "Poskytovateľ odmietol správu." });
    expect(argOf(messageUpdate, "update")).toMatchObject({ status: "failed", status_detail: "send_failed" });
  });
});

describe("transport preflight", () => {
  beforeEach(() => adminMock.mockReset());

  it("refuses before any audit row when the transport preflight rejects (kill switch)", async () => {
    const from = vi.fn();
    adminMock.mockReturnValue({ from });
    const send = vi.fn();
    const transport: SmsTransport = {
      preflight: vi.fn().mockRejectedValue(new SmsWorkflowError("Odosielanie SMS je vypnuté (kill switch).", 423)),
      send,
    };

    const failure = await sendCustomSms(
      { actorProfileId: "profile-1", body: "Ahoj", caseId: null, organizationId: "org-1", toNumber: "0905 123 456" },
      { transport },
    ).catch((error: unknown) => error);

    expect((failure as SmsWorkflowError).status).toBe(423);
    expect(transport.preflight).toHaveBeenCalledWith({ organizationId: "org-1" });
    expect(send).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});

describe("resolveSmsTransport", () => {
  const previous = process.env.TELNYX_API_KEY;

  afterEach(() => {
    if (previous === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = previous;
  });

  it("falls back to the not-configured transport without an API key", () => {
    delete process.env.TELNYX_API_KEY;
    expect(resolveSmsTransport()).toBe(notConfiguredTransport);
  });

  it("returns the Telnyx transport once the API key is present", () => {
    process.env.TELNYX_API_KEY = "KEYtest";
    const transport = resolveSmsTransport();
    expect(transport).not.toBe(notConfiguredTransport);
    expect(typeof transport.preflight).toBe("function");
  });
});

describe("normalizeSmsRecipient", () => {
  it.each([
    ["0905 123 456", "+421905123456"],
    ["+421 905 123 456", "+421905123456"],
    ["00420777123456", "+420777123456"],
    ["421905123456", "+421905123456"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeSmsRecipient(input)).toBe(expected);
  });

  it.each(["", "abc", "+0421905123456", "123"])("rejects %j with a 400 workflow error", (input) => {
    let failure: unknown = null;

    try {
      normalizeSmsRecipient(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SmsWorkflowError);
    expect((failure as SmsWorkflowError).status).toBe(400);
  });
});

function makeQuery(table: string): QueryRecorder {
  const calls: QueryCall[] = [];
  const query: Record<string, unknown> = {};

  for (const method of CHAINED_METHODS) {
    query[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return query;
    };
  }

  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(resolveResult(table, calls)).then(resolve, reject);

  return { calls, query };
}

function resolveResult(table: string, calls: QueryCall[]) {
  const insert = calls.find((call) => call.method === "insert");

  if (insert) {
    const payload = insert.args[0] as Record<string, unknown>;
    return { data: { ...payload, id: table === "motorist_sms_messages" ? "sms-1" : "attempt-1" }, error: null };
  }

  return { data: null, error: null };
}

function argOf(recorder: QueryRecorder | undefined, method: string) {
  return recorder?.calls.find((call) => call.method === method)?.args[0];
}
