import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
const interlockMocks = vi.hoisted(() => ({ releaseTerminal: vi.fn() }));
vi.mock("./assignment-interlock", async (importOriginal) => ({
  ...await importOriginal<typeof import("./assignment-interlock")>(),
  releaseTerminalCommandAssignmentGuard: interlockMocks.releaseTerminal,
}));

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeViptelMutationCommand } from "@/server/telephony/mutation-command-authority";
import {
  beginTelephonyCommand,
  beginBrowserDtmfTransferIntent,
  beginSerializedOutboundCall,
  reconcileBrowserSipInvite,
  recordBrowserDtmfTransferDelivery,
  recordUnsentBrowserSipInvite,
} from "./telephony-commands";

const adminMock = vi.mocked(createSupabaseAdminClient);
const ids = {
  call: "11111111-1111-4111-8111-111111111111",
  command: "22222222-2222-4222-8222-222222222222",
  extension: "33333333-3333-4333-8333-333333333333",
  organization: "44444444-4444-4444-8444-444444444444",
  profile: "55555555-5555-4555-8555-555555555555",
};

describe("browser DTMF command audit", () => {
  beforeEach(() => {
    adminMock.mockReset();
    interlockMocks.releaseTerminal.mockReset();
    process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
    process.env.VIPTEL_LIVE_MUTATION_TOKEN = "a".repeat(32);
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    delete process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
    delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
    delete process.env.VERCEL_ENV;
  });

  it("builds and stores the canonical server-side tone plan with personal extension ownership evidence", async () => {
    const latest = queryResult({ data: [], error: null });
    const insert = queryResult({ data: { id: ids.command }, error: null });
    const immutableIntent = queryResult({ data: { id: "66666666-6666-4666-8666-666666666666" }, error: null });
    let index = 0;
    adminMock.mockReturnValue({ from: vi.fn(() => [latest, insert, immutableIntent][index++].query) } as never);

    await expect(beginBrowserDtmfTransferIntent({
      organizationId: ids.organization,
      requestedBy: ids.profile,
      callId: ids.call,
      extensionId: ids.extension,
      authorizedViptelUniqueId: "1779959213.4",
      destination: "23",
      mode: "blind",
      assignmentGuard: assignmentGuard(),
    })).resolves.toMatchObject({
      id: ids.command,
      authorizedViptelUniqueId: "1779959213.4",
      tonePlan: ["#", "#", "2", "3"],
    });

    const payload = insert.calls.find((call) => call.method === "insert")?.args[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      call_id: ids.call,
      extension_id: ids.extension,
      command_type: "call.transfer.dtmf",
      status: "accepted",
    });
    expect(payload.request_payload).toMatchObject({
      destination: "23",
      authorizedViptelUniqueId: "1779959213.4",
      mode: "blind",
      toneCount: 4,
      transport: "browser_dtmf",
      confirmationModel: "unconfirmed",
    });
    expect(payload.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
    const audit = immutableIntent.calls.find((call) => call.method === "insert")?.args[0] as Record<string, unknown>;
    expect(audit).toMatchObject({
      action: "telephony.command.browser_dtmf.intent",
      entity_id: ids.call,
      entity_type: "motorist_calls",
    });
  });

  it("persists an optional queue-availability assignment guard inside request_payload", async () => {
    const insert = queryResult({ data: { id: ids.command }, error: null });
    adminMock.mockReturnValue({ from: vi.fn(() => insert.query) } as never);
    const guard = assignmentGuard();

    await expect(beginTelephonyCommand({
      organizationId: ids.organization,
      requestedBy: ids.profile,
      commandType: "queue.add",
      queueId: "77777777-7777-4777-8777-777777777777",
      extensionId: ids.extension,
      assignmentGuard: guard,
      requestPayload: {
        queue: "601",
        extension: "20",
        action: "add",
        routingAvailability: { kind: "availability", queue: "601", extension: "20", revision: 2 },
      },
    })).resolves.toEqual({ id: ids.command, idempotencyKey: expect.any(String) });

    const written = insert.calls.find((call) => call.method === "insert")?.args[0] as {
      request_payload: Record<string, unknown>;
    };
    expect(written.request_payload).toMatchObject({
      assignmentGuard: guard,
      queue: "601",
      extension: "20",
    });
  });

  it.each([
    ["accepted without a report", "none"],
    ["partial delivery", "partial"],
    ["complete delivery", "complete"],
    ["malformed failed delivery", "malformed"],
  ] as const)("blocks a second transfer after %s", async (_label, outcome) => {
    const latest = queryResult({ data: immutableDtmfHistory(outcome), error: null });
    const from = vi.fn(() => latest.query);
    adminMock.mockReturnValue({ from } as never);

    await expect(beginBrowserDtmfTransferIntent(transferIntent())).rejects.toMatchObject({ status: 409 });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("allows one next intent after an immutable zero-tone failure and atomically rejects a concurrent duplicate", async () => {
    const retryable = immutableDtmfHistory("failed");
    const latest = queryResult({ data: retryable, error: null });
    const insert = queryResult({ data: { id: "66666666-6666-4666-8666-666666666666" }, error: null });
    const immutableIntent = queryResult({ data: { id: "77777777-7777-4777-8777-777777777777" }, error: null });
    let index = 0;
    adminMock.mockReturnValue({ from: vi.fn(() => [latest, insert, immutableIntent][index++].query) } as never);

    const created = await beginBrowserDtmfTransferIntent(transferIntent());
    const firstPayload = insert.calls.find((call) => call.method === "insert")?.args[0] as Record<string, unknown>;
    expect(created.id).toBe("66666666-6666-4666-8666-666666666666");
    expect(firstPayload.idempotency_key).toMatch(/^[0-9a-f]{64}$/);

    const concurrentLatest = queryResult({ data: retryable, error: null });
    const duplicate = queryResult({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    index = 0;
    adminMock.mockReturnValue({ from: vi.fn(() => [concurrentLatest, duplicate][index++].query) } as never);

    await expect(beginBrowserDtmfTransferIntent(transferIntent())).rejects.toMatchObject({ status: 409 });
    const racedPayload = duplicate.calls.find((call) => call.method === "insert")?.args[0] as Record<string, unknown>;
    expect(racedPayload.idempotency_key).toBe(firstPayload.idempotency_key);
  });

  it("keeps a completed tone send accepted and explicitly unconfirmed", async () => {
    const { update, result } = mockDeliveryQueries();
    await expect(recordBrowserDtmfTransferDelivery(deliveryInput({ outcome: "complete" }))).resolves.toMatchObject({
      status: "accepted",
    });
    const written = update.calls.find((call) => call.method === "update")?.args[0] as Record<string, unknown>;
    expect(written.status).toBe("accepted");
    expect(written.provider_response).toMatchObject({
      deliveryUncertain: false,
      browserDtmfDelivery: {
        outcome: "complete",
        sentToneCount: 4,
        totalToneCount: 4,
        confirmationModel: "unconfirmed",
      },
    });
    expect(result.from).toHaveBeenCalledTimes(4);
  });

  it("finalizes an already-authorized delivery even after the live mutation gate is disabled", async () => {
    const { update } = mockDeliveryQueries();
    process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "false";

    await expect(recordBrowserDtmfTransferDelivery(deliveryInput({ outcome: "complete" }))).resolves.toMatchObject({
      status: "accepted",
    });
    expect(update.calls.some((call) => call.method === "update")).toBe(true);
  });

  it("marks only a zero-tone failure as failed and retryable", async () => {
    const { update } = mockDeliveryQueries("failed");
    await recordBrowserDtmfTransferDelivery(deliveryInput({
      outcome: "failed",
      sentToneCount: 0,
      failedToneIndex: 0,
      error: "session ended",
    }));
    const written = update.calls.find((call) => call.method === "update")?.args[0] as Record<string, unknown>;
    expect(written).toMatchObject({
      status: "failed",
      provider_response: {
        autoRetryAllowed: true,
        deliveryUncertain: false,
        browserDtmfDelivery: { failedToneIndex: 0, sentToneCount: 0 },
      },
    });
  });

  it("keeps partial delivery accepted, uncertain and non-retryable with server recovery guidance", async () => {
    const { update } = mockDeliveryQueries();
    await recordBrowserDtmfTransferDelivery(deliveryInput({ outcome: "partial", sentToneCount: 2, error: "media failed" }));
    const written = update.calls.find((call) => call.method === "update")?.args[0] as Record<string, unknown>;
    expect(written).toMatchObject({
      status: "accepted",
      provider_response: {
        autoRetryAllowed: false,
        deliveryUncertain: true,
        browserDtmfDelivery: {
          failedToneIndex: 2,
          sentToneCount: 2,
          totalToneCount: 4,
          deliveryUncertain: true,
        },
      },
    });
    expect(JSON.stringify(written)).toContain("DTMF sekvenciu neopakujte");
  });

  it("filters the command lookup by organization and requesting actor", async () => {
    const { lookup } = mockDeliveryQueries();
    await recordBrowserDtmfTransferDelivery(deliveryInput({ outcome: "complete" }));
    expect(lookup.calls).toContainEqual({ method: "eq", args: ["organization_id", ids.organization] });
    expect(lookup.calls).toContainEqual({ method: "eq", args: ["call_id", ids.call] });
    expect(lookup.calls).toContainEqual({ method: "eq", args: ["requested_by", ids.profile] });
    expect(lookup.calls).toContainEqual({ method: "eq", args: ["command_type", "call.transfer.dtmf"] });
  });

  it("treats an identical duplicate report as a no-op and rejects a conflicting duplicate", async () => {
    const identical = queryResult({ data: existingCommand({}), error: null });
    const identicalHistory = queryResult({ data: immutableDtmfHistory("partial"), error: null });
    const identicalUpdate = queryResult({ data: { id: ids.command, status: "accepted", provider_response: {} }, error: null });
    let index = 0;
    const identicalFrom = vi.fn(() => [identical, identicalHistory, identicalUpdate][index++].query);
    adminMock.mockReturnValueOnce({ from: identicalFrom } as never);
    await expect(recordBrowserDtmfTransferDelivery(deliveryInput({ outcome: "partial", sentToneCount: 2 }))).resolves.toMatchObject({
      id: ids.command,
    });
    expect(identicalFrom).toHaveBeenCalledTimes(3);

    const conflict = queryResult({ data: existingCommand({}), error: null });
    const conflictHistory = queryResult({ data: immutableDtmfHistory("partial"), error: null });
    index = 0;
    adminMock.mockReturnValueOnce({ from: vi.fn(() => [conflict, conflictHistory][index++].query) } as never);
    await expect(recordBrowserDtmfTransferDelivery(deliveryInput({ outcome: "complete" }))).rejects.toMatchObject({ status: 409 });
  });

  it("uses updated_at CAS after the immutable result is persisted", async () => {
    const lookup = queryResult({ data: existingCommand({}), error: null });
    const history = queryResult({ data: immutableDtmfHistory("none"), error: null });
    const immutableDelivery = queryResult({ data: { id: "77777777-7777-4777-8777-777777777777" }, error: null });
    const update = queryResult({ data: null, error: null });
    let index = 0;
    adminMock.mockReturnValue({ from: vi.fn(() => [lookup, history, immutableDelivery, update][index++].query) } as never);
    await expect(recordBrowserDtmfTransferDelivery(deliveryInput({ outcome: "complete" }))).resolves.toMatchObject({ id: ids.command });
    expect(update.calls).toContainEqual({ method: "eq", args: ["updated_at", "2026-08-04T16:00:00.000Z"] });
  });

  it("rejects a member-writable command whose authorized provider unique id differs from the immutable intent", async () => {
    const lookup = queryResult({
      data: {
        ...existingCommand({}),
        request_payload: {
          ...existingCommand({}).request_payload,
          authorizedViptelUniqueId: "forged-call",
        },
      },
      error: null,
    });
    const history = queryResult({ data: immutableDtmfHistory("none"), error: null });
    let index = 0;
    adminMock.mockReturnValue({ from: vi.fn(() => [lookup, history][index++].query) } as never);

    await expect(recordBrowserDtmfTransferDelivery(deliveryInput({ outcome: "complete" })))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe("serialized outbound call.create", () => {
  beforeEach(() => {
    adminMock.mockReset();
    process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
    process.env.VIPTEL_LIVE_MUTATION_TOKEN = "a".repeat(32);
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    delete process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
    delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
    delete process.env.VERCEL_ENV;
  });

  it("rejects a reset DB state while VIPTel still has an active source leg", async () => {
    const from = vi.fn();
    adminMock.mockReturnValue({ from } as never);
    await expect(beginSerializedOutboundCall({
      ...outboundInput(),
      providerActiveCalls: [{ direction: "outbound", status: "answered", callerExtension: "20", raw: {} }],
    })).rejects.toMatchObject({ status: 409 });
    expect(from).not.toHaveBeenCalled();
  });

  it.each(["ended", "failed", "missed", "abandoned_queue"] as const)(
    "does not block outbound creation from a terminal provider %s row",
    async (status) => {
      const activeCall = queryResult({ data: null, error: null });
      const terminalCommand = queryResult({
        data: { id: ids.command, status: "failed", created_at: "2026-08-04T15:00:00.000Z" },
        error: null,
      });
      const insert = queryResult({ data: { id: "66666666-6666-4666-8666-666666666666" }, error: null });
      let index = 0;
      adminMock.mockReturnValue({ from: vi.fn(() => [activeCall, terminalCommand, insert][index++].query) } as never);

      await expect(beginSerializedOutboundCall({
        ...outboundInput(),
        providerActiveCalls: [{ direction: "outbound", status, callerExtension: "20", raw: {} }],
      })).resolves.toMatchObject({ id: "66666666-6666-4666-8666-666666666666" });
    },
  );

  it("fails closed when the owned extension already has an active call", async () => {
    const activeCall = queryResult({ data: { id: ids.call, status: "answered" }, error: null });
    const latestCommand = queryResult({ data: null, error: null });
    let index = 0;
    const from = vi.fn(() => [activeCall, latestCommand][index++].query);
    adminMock.mockReturnValue({ from } as never);

    await expect(beginSerializedOutboundCall(outboundInput())).rejects.toMatchObject({ status: 409 });
    expect(from).toHaveBeenCalledTimes(2);
    expect(activeCall.calls).toContainEqual({
      method: "or",
      args: [`extension_id.eq.${ids.extension},caller_extension.eq.20,received_extension.eq.20,destination_extension.eq.20`],
    });
  });

  it.each(["queued", "sent", "accepted", "future_unknown_status"])("blocks a %s call.create command without inserting another", async (status) => {
    const activeCall = queryResult({ data: null, error: null });
    const latestCommand = queryResult({
      data: { id: ids.command, status, created_at: "2026-08-04T15:00:00.000Z" },
      error: null,
    });
    let index = 0;
    const from = vi.fn(() => [activeCall, latestCommand][index++].query);
    adminMock.mockReturnValue({ from } as never);

    await expect(beginSerializedOutboundCall(outboundInput())).rejects.toMatchObject({ status: 409 });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it.each(["failed", "confirmed_by_event"])("allows a new call after terminal %s and no active DB call", async (status) => {
    const activeCall = queryResult({ data: null, error: null });
    const terminalCommand = queryResult({
      data: { id: ids.command, status, created_at: "2026-08-04T15:00:00.000Z" },
      error: null,
    });
    const insert = queryResult({ data: { id: "66666666-6666-4666-8666-666666666666" }, error: null });
    let index = 0;
    adminMock.mockReturnValue({ from: vi.fn(() => [activeCall, terminalCommand, insert][index++].query) } as never);

    await expect(beginSerializedOutboundCall(outboundInput())).resolves.toMatchObject({
      id: "66666666-6666-4666-8666-666666666666",
    });
    const payload = insert.calls.find((call) => call.method === "insert")?.args[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      command_type: "call.create",
      extension_id: ids.extension,
      status: "queued",
    });
    expect(payload.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks a new call after an uncertain websocket delivery even when the provider snapshot is still empty", async () => {
    const activeCall = queryResult({ data: null, error: null });
    const uncertainCommand = queryResult({
      data: {
        id: ids.command,
        status: "failed",
        created_at: "2026-08-04T15:00:00.000Z",
        provider_response: { deliveryUncertain: true, reason: "dispatch_failed" },
      },
      error: null,
    });
    let index = 0;
    const from = vi.fn(() => [activeCall, uncertainCommand][index++].query);
    adminMock.mockReturnValue({ from } as never);

    await expect(beginSerializedOutboundCall(outboundInput())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("mohol byť odoslaný"),
    });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("allows one retry after a signed browser SIP confirmation timeout and a fresh empty provider snapshot", async () => {
    const activeCall = queryResult({ data: null, error: null });
    const timedOutBrowserCall = queryResult({
      data: signedBrowserSipCommand({
        status: "failed",
        providerResponse: {
          deliveryUncertain: true,
          reason: "provider_confirmation_timeout",
        },
      }),
      error: null,
    });
    const insert = queryResult({ data: { id: "66666666-6666-4666-8666-666666666666" }, error: null });
    let index = 0;
    adminMock.mockReturnValue({ from: vi.fn(() => [activeCall, timedOutBrowserCall, insert][index++].query) } as never);

    await expect(beginSerializedOutboundCall({
      ...outboundInput(),
      providerSnapshotCapturedAt: new Date().toISOString(),
    })).resolves.toMatchObject({ id: "66666666-6666-4666-8666-666666666666" });
  });

  it("maps a concurrent call.create fence collision to 409", async () => {
    const activeCall = queryResult({ data: null, error: null });
    const terminalCommand = queryResult({
      data: { id: ids.command, status: "failed", created_at: "2026-08-04T15:00:00.000Z" },
      error: null,
    });
    const duplicate = queryResult({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    let index = 0;
    adminMock.mockReturnValue({ from: vi.fn(() => [activeCall, terminalCommand, duplicate][index++].query) } as never);

    await expect(beginSerializedOutboundCall(outboundInput())).rejects.toMatchObject({ status: 409 });
  });
});

describe("unsent browser SIP INVITE audit", () => {
  beforeEach(() => {
    adminMock.mockReset();
    process.env.VIPTEL_LIVE_MUTATION_TOKEN = "a".repeat(32);
  });

  afterEach(() => {
    delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
  });

  it("CAS-transitions only the actor's accepted browser intent to a certain failed state", async () => {
    const lookup = queryResult({ data: signedBrowserSipCommand(), error: null });
    const update = queryResult({ data: { id: ids.command }, error: null });
    let index = 0;
    const from = vi.fn(() => [lookup, update][index++].query);
    adminMock.mockReturnValue({ from } as never);

    await expect(recordUnsentBrowserSipInvite(unsentInviteInput())).resolves.toEqual({
      id: ids.command,
      status: "failed",
    });
    expect(lookup.calls).toContainEqual({ method: "eq", args: ["organization_id", ids.organization] });
    expect(lookup.calls).toContainEqual({ method: "eq", args: ["requested_by", ids.profile] });
    expect(update.calls).toContainEqual({ method: "eq", args: ["status", "accepted"] });
    expect(update.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      status: "failed",
      provider_response: {
        deliveryUncertain: false,
        reason: "browser_sip_invite_not_sent",
        stage: "before_invite_send",
      },
    });
  });

  it("is idempotent only for the exact already-recorded certain failure", async () => {
    const lookup = queryResult({
      data: signedBrowserSipCommand({
        status: "failed",
        providerResponse: {
          deliveryUncertain: false,
          reason: "browser_sip_invite_not_sent",
        },
      }),
      error: null,
    });
    const from = vi.fn(() => lookup.query);
    adminMock.mockReturnValue({ from } as never);

    await expect(recordUnsentBrowserSipInvite(unsentInviteInput())).resolves.toEqual({
      id: ids.command,
      status: "failed",
    });
    expect(from).toHaveBeenCalledOnce();
  });

  it("never downgrades a confirmed event when it wins the accepted-state CAS race", async () => {
    const lookup = queryResult({ data: signedBrowserSipCommand(), error: null });
    const update = queryResult({ data: null, error: null });
    const raced = queryResult({ data: signedBrowserSipCommand({ status: "confirmed_by_event" }), error: null });
    let index = 0;
    adminMock.mockReturnValue({ from: vi.fn(() => [lookup, update, raced][index++].query) } as never);

    await expect(recordUnsentBrowserSipInvite(unsentInviteInput())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("už tento hovor potvrdil"),
    });
  });

  it("never converts an uncertain failed command into a retryable failure", async () => {
    const lookup = queryResult({
      data: signedBrowserSipCommand({
        status: "failed",
        providerResponse: { deliveryUncertain: true, reason: "provider_confirmation_timeout" },
      }),
      error: null,
    });
    const from = vi.fn(() => lookup.query);
    adminMock.mockReturnValue({ from } as never);

    await expect(recordUnsentBrowserSipInvite(unsentInviteInput())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("neistý"),
    });
    expect(from).toHaveBeenCalledOnce();
  });

  it("rejects a tampered authority and a signed non-browser command", async () => {
    const tampered = signedBrowserSipCommand();
    tampered.request_payload = { ...tampered.request_payload as Record<string, unknown>, destination: "00421999999999" };
    const tamperedLookup = queryResult({ data: tampered, error: null });
    adminMock.mockReturnValueOnce({ from: vi.fn(() => tamperedLookup.query) } as never);
    await expect(recordUnsentBrowserSipInvite(unsentInviteInput())).rejects.toMatchObject({ status: 409 });

    const listenerLookup = queryResult({
      data: signedBrowserSipCommand({ executionTarget: "listener_websocket", transport: "outbox_websocket" }),
      error: null,
    });
    adminMock.mockReturnValueOnce({ from: vi.fn(() => listenerLookup.query) } as never);
    await expect(recordUnsentBrowserSipInvite(unsentInviteInput())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("nepatrí priamemu hovoru"),
    });
  });

  it("fails closed when the actor-scoped command lookup returns no row", async () => {
    const lookup = queryResult({ data: null, error: null });
    adminMock.mockReturnValue({ from: vi.fn(() => lookup.query) } as never);

    await expect(recordUnsentBrowserSipInvite({
      ...unsentInviteInput(),
      requestedBy: "66666666-6666-4666-8666-666666666666",
    })).rejects.toMatchObject({ status: 404 });
  });
});

describe("browser SIP reconciliation", () => {
  beforeEach(() => {
    adminMock.mockReset();
    process.env.VIPTEL_LIVE_MUTATION_TOKEN = "a".repeat(32);
  });

  afterEach(() => {
    delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
  });

  it("closes an accepted intent as certain failed after a fresh empty provider and DB check", async () => {
    const lookup = queryResult({ data: signedBrowserSipCommand(), error: null });
    const activeCall = queryResult({ data: null, error: null });
    const recentCalls = queryResult({ data: [], error: null });
    const update = queryResult({
      data: { id: ids.command, status: "failed" },
      error: null,
    });
    let index = 0;
    adminMock.mockReturnValue({
      from: vi.fn(() => [lookup, activeCall, recentCalls, update][index++].query),
    } as never);

    const input = reconcileInput({
      browserReport: { outcome: "rejected", statusCode: 486 },
    });
    await expect(reconcileBrowserSipInvite(input)).resolves.toEqual({
      deliveryUncertain: false,
      id: ids.command,
      status: "failed",
    });
    expect(update.calls).toContainEqual({ method: "eq", args: ["updated_at", "2026-08-06T13:00:00.000Z"] });
    expect(update.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      status: "failed",
      provider_response: {
        browserReport: { outcome: "rejected", statusCode: 486 },
        deliveryUncertain: false,
        reason: "browser_sip_reconciled_no_call",
      },
    });
    expect(recentCalls.calls).toContainEqual({
      method: "lte",
      // Reconciliation deliberately caps the DB window at two minutes after
      // the fixed command timestamp, even when today's fresh provider capture
      // is much later. Keeping this expectation dynamic made the test expire.
      args: ["created_at", "2026-08-06T13:02:00.000Z"],
    });
  });

  it("recovers a timed-out intent when a matching provider call row already exists", async () => {
    const lookup = queryResult({
      data: signedBrowserSipCommand({
        status: "failed",
        providerResponse: { deliveryUncertain: true, reason: "provider_confirmation_timeout" },
      }),
      error: null,
    });
    const activeCall = queryResult({ data: null, error: null });
    const recentCalls = queryResult({
      data: [{
        id: ids.call,
        status: "ended",
        called_number: null,
        destination_number: "0900111222",
        created_at: "2026-08-06T13:00:02.000Z",
      }],
      error: null,
    });
    const update = queryResult({
      data: { id: ids.command, status: "confirmed_by_event" },
      error: null,
    });
    let index = 0;
    adminMock.mockReturnValue({
      from: vi.fn(() => [lookup, activeCall, recentCalls, update][index++].query),
    } as never);

    await expect(reconcileBrowserSipInvite(reconcileInput())).resolves.toEqual({
      id: ids.command,
      status: "confirmed_by_event",
    });
    expect(update.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      call_id: ids.call,
      status: "confirmed_by_event",
      provider_response: {
        confirmation: {
          callId: ids.call,
          source: "browser_sip_reconciled_provider_call",
        },
        deliveryUncertain: false,
      },
    });
  });

  it("fails closed while the fresh provider snapshot still has a call on the source extension", async () => {
    const lookup = queryResult({ data: signedBrowserSipCommand(), error: null });
    const from = vi.fn(() => lookup.query);
    adminMock.mockReturnValue({ from } as never);

    await expect(reconcileBrowserSipInvite(reconcileInput({
      providerActiveCalls: [{
        callerExtension: "20",
        direction: "outbound",
        raw: {},
        status: "answered",
      }],
    }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("stále eviduje aktívny hovor"),
    });
    expect(from).toHaveBeenCalledOnce();
  });

  it("rejects a stale provider snapshot before reading the command", async () => {
    const from = vi.fn();
    adminMock.mockReturnValue({ from } as never);

    await expect(reconcileBrowserSipInvite(reconcileInput({
      providerCapturedAt: "2026-08-01T00:00:00.000Z",
    }))).rejects.toMatchObject({ status: 409 });
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects timeout-only and malformed SIP reports before reading provider-backed state", async () => {
    const from = vi.fn();
    adminMock.mockReturnValue({ from } as never);

    await expect(reconcileBrowserSipInvite(reconcileInput({
      browserReport: { outcome: "confirmation_timeout" },
    }))).rejects.toMatchObject({ status: 400 });
    await expect(reconcileBrowserSipInvite(reconcileInput({
      browserReport: { outcome: "rejected", statusCode: 200 },
    }))).rejects.toMatchObject({ status: 400 });
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a browser intent without an owned extension before composing the active-call filter", async () => {
    const malformed = signedBrowserSipCommand({ extensionId: null });
    const lookup = queryResult({ data: malformed, error: null });
    const from = vi.fn(() => lookup.query);
    adminMock.mockReturnValue({ from } as never);

    await expect(reconcileBrowserSipInvite(reconcileInput())).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("platné smerovanie"),
    });
    expect(from).toHaveBeenCalledOnce();
  });
});

function deliveryInput(report: Parameters<typeof recordBrowserDtmfTransferDelivery>[0]["report"]) {
  return { callId: ids.call, commandId: ids.command, organizationId: ids.organization, requestedBy: ids.profile, report };
}

function transferIntent() {
  return {
    organizationId: ids.organization,
    requestedBy: ids.profile,
    callId: ids.call,
    extensionId: ids.extension,
    authorizedViptelUniqueId: "1779959213.4",
    destination: "23",
    mode: "blind" as const,
    assignmentGuard: assignmentGuard(),
  };
}

function outboundInput() {
  return {
    organizationId: ids.organization,
    requestedBy: ids.profile,
    extensionId: ids.extension,
    requestPayload: { caller: "20", destination: "00421900111222" },
    initialStatus: "queued" as const,
    assignmentGuard: assignmentGuard(),
    providerActiveCalls: [],
  };
}

function unsentInviteInput() {
  return {
    commandId: ids.command,
    organizationId: ids.organization,
    requestedBy: ids.profile,
  };
}

function reconcileInput(overrides: Partial<Parameters<typeof reconcileBrowserSipInvite>[0]> = {}) {
  return {
    browserReport: { outcome: "ended_before_answer" },
    commandId: ids.command,
    organizationId: ids.organization,
    providerActiveCalls: [],
    providerCapturedAt: new Date().toISOString(),
    requestedBy: ids.profile,
    ...overrides,
  };
}

function signedBrowserSipCommand(options: {
  executionTarget?: "event_correlation_only" | "listener_websocket";
  extensionId?: string | null;
  providerResponse?: Record<string, unknown>;
  status?: string;
  transport?: "browser_sip" | "outbox_websocket";
} = {}) {
  const transport = options.transport ?? "browser_sip";
  const executionTarget = options.executionTarget ?? "event_correlation_only";
  const base = {
    id: ids.command,
    organization_id: ids.organization,
    provider: "viptel",
    command_type: "call.create",
    requested_by: ids.profile,
    call_id: null,
    queue_id: null,
    extension_id: options.extensionId === undefined ? ids.extension : options.extensionId,
    idempotency_key: "d".repeat(64),
    created_at: "2026-08-06T13:00:00.000Z",
    updated_at: "2026-08-06T13:00:00.000Z",
  };
  const requestPayload = {
    caller: "20",
    destination: "00421900111222",
    transport,
  };
  const signed = authorizeViptelMutationCommand({
    commandId: base.id,
    organizationId: base.organization_id,
    provider: base.provider,
    commandType: base.command_type,
    requestedBy: base.requested_by,
    callId: base.call_id,
    queueId: base.queue_id,
    extensionId: base.extension_id,
    idempotencyKey: base.idempotency_key,
    executionTarget,
    requestPayload,
  });
  return {
    ...base,
    request_payload: signed.requestPayload,
    provider_response: options.providerResponse ?? {},
    status: options.status ?? "accepted",
  };
}

function assignmentGuard() {
  return {
    claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    extension: "20",
    extensionId: ids.extension,
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    lifecycleEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    profileId: ids.profile,
  };
}

function existingCommand(providerResponse: Record<string, unknown>) {
  return {
    id: ids.command,
    organization_id: ids.organization,
    requested_by: ids.profile,
    call_id: ids.call,
    extension_id: ids.extension,
    command_type: "call.transfer.dtmf",
    status: "accepted",
    provider_response: providerResponse,
    request_payload: {
      assignmentGuard: assignmentGuard(),
      toneCount: 4,
      mode: "blind",
      destination: "23",
      authorizedViptelUniqueId: "1779959213.4",
      requestedAt: "2026-08-04T15:00:00.000Z",
      transport: "browser_dtmf",
    },
    updated_at: "2026-08-04T16:00:00.000Z",
  };
}

function mockDeliveryQueries(status: "accepted" | "failed" = "accepted") {
  const lookup = queryResult({ data: existingCommand({}), error: null });
  const history = queryResult({ data: immutableDtmfHistory("none"), error: null });
  const immutableDelivery = queryResult({ data: { id: "77777777-7777-4777-8777-777777777777" }, error: null });
  const update = queryResult({ data: { id: ids.command, status, provider_response: {} }, error: null });
  let index = 0;
  const from = vi.fn(() => [lookup, history, immutableDelivery, update][index++].query);
  adminMock.mockReturnValue({ from } as never);
  return { lookup, update, result: { from } };
}

function immutableDtmfHistory(outcome: "none" | "failed" | "partial" | "complete" | "malformed") {
  const intent = {
    schemaVersion: 1,
    intentId: ids.command,
    commandId: ids.command,
    organizationId: ids.organization,
    requestedBy: ids.profile,
    callId: ids.call,
    extensionId: ids.extension,
    authorizedViptelUniqueId: "1779959213.4",
    destination: "23",
    mode: "blind",
    toneCount: 4,
    tonePlanHash: dtmfTonePlanHash(["#", "#", "2", "3"]),
    parentIntentId: null,
    assignmentGuard: assignmentGuard(),
    requestedAt: "2026-08-04T15:00:00.000Z",
  };
  const rows: Array<Record<string, unknown>> = [{
    id: "66666666-6666-4666-8666-666666666666",
    action: "telephony.command.browser_dtmf.intent",
    after_payload: { browser_dtmf_intent: intent },
    created_at: "2026-08-04T15:00:00.000Z",
  }];
  if (outcome === "none") return rows;
  const common = {
    totalToneCount: 4,
    attemptedAt: "2026-08-04T15:01:00.000Z",
    confirmationModel: "unconfirmed",
  };
  const delivery = outcome === "failed"
    ? {
        ...common,
        outcome: "failed",
        sentToneCount: 0,
        failedToneIndex: 0,
        deliveryUncertain: false,
        autoRetryAllowed: true,
      }
    : outcome === "partial"
      ? {
          ...common,
          outcome: "partial",
          sentToneCount: 2,
          failedToneIndex: 2,
          deliveryUncertain: true,
          autoRetryAllowed: false,
        }
      : outcome === "complete"
        ? {
            ...common,
            outcome: "complete",
            sentToneCount: 4,
            deliveryUncertain: false,
            autoRetryAllowed: false,
          }
        : {
            ...common,
            outcome: "failed",
            sentToneCount: 1,
            failedToneIndex: 1,
            deliveryUncertain: false,
            autoRetryAllowed: true,
          };
  rows.push({
    id: "77777777-7777-4777-8777-777777777777",
    action: "telephony.command.browser_dtmf.delivery",
    after_payload: {
      browser_dtmf_delivery: {
        schemaVersion: 1,
        intentId: ids.command,
        commandId: ids.command,
        organizationId: ids.organization,
        requestedBy: ids.profile,
        callId: ids.call,
        extensionId: ids.extension,
        delivery,
      },
    },
    created_at: "2026-08-04T15:01:00.000Z",
  });
  return rows;
}

function dtmfTonePlanHash(tones: string[]) {
  const hash = createHash("sha256");
  hash.update("browser-dtmf-tone-plan");
  for (const tone of tones) {
    hash.update("\0");
    hash.update(tone);
  }
  return hash.digest("hex");
}

function queryResult(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        if (property === "single" || property === "maybeSingle") return Promise.resolve(result);
        return query;
      };
    },
  });
  return { calls, query };
}
