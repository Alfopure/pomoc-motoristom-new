import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routingMocks = vi.hoisted(() => ({
  advanceConfirmed: vi.fn(),
  markFailed: vi.fn(),
}));
const interlockMocks = vi.hoisted(() => ({ releaseTerminal: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("./dispatch-routing", async (importOriginal) => ({
  ...await importOriginal<typeof import("./dispatch-routing")>(),
  advanceDispatchRoutingOperationForConfirmedCommand: routingMocks.advanceConfirmed,
  markDispatchRoutingCommandFailed: routingMocks.markFailed,
}));
vi.mock("./assignment-interlock", async (importOriginal) => ({
  ...await importOriginal<typeof import("./assignment-interlock")>(),
  releaseTerminalCommandAssignmentGuard: interlockMocks.releaseTerminal,
}));

import type { Json } from "@/lib/supabase/database.types";
import { authorizeViptelMutationCommand } from "./mutation-command-authority";
import {
  confirmTelephonyCommandsFromViptelEvent,
  type TelephonyCommandRow,
  ViptelCommandOutbox,
} from "./viptel-command-outbox";

const AUTHORITY_TOKEN = "test-authority-token-at-least-32-characters";
const NOW = "2026-08-07T10:00:00.000Z";
const ids = {
  command: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  profile: "33333333-3333-4333-8333-333333333333",
  operation: "44444444-4444-4444-8444-444444444444",
};

describe("VIPTel outbox routing hardening", () => {
  beforeEach(() => {
    routingMocks.advanceConfirmed.mockReset();
    routingMocks.advanceConfirmed.mockResolvedValue(true);
    routingMocks.markFailed.mockReset();
    routingMocks.markFailed.mockResolvedValue(undefined);
    interlockMocks.releaseTerminal.mockReset();
    interlockMocks.releaseTerminal.mockResolvedValue(undefined);
    vi.stubEnv("VIPTEL_LIVE_MUTATIONS_ENABLED", "true");
    vi.stubEnv("VIPTEL_LIVE_MUTATION_TOKEN", AUTHORITY_TOKEN);
    // Vercel production runs Vitest with the real listener environment. Keep
    // these mutation-only scenarios independent from the separately gated
    // provider snapshot queue, otherwise an empty mutation queue legitimately
    // performs one additional snapshot lookup.
    vi.stubEnv("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED", "false");
    vi.stubEnv("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN", "");
    vi.stubEnv("VERCEL_ENV", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("durably degrades a routing operation when queued authority is rejected before claim", async () => {
    const signed = routingCommand({ status: "queued" });
    const queued = {
      ...signed,
      request_payload: {
        ...asRecord(signed.request_payload),
        extension: "21",
      } as Json,
    };
    const failed = routingFailureProjection(queued);
    const failureUpdate = queryResult({ data: failed, error: null });
    const client = sequentialClient([
      queryResult({ data: [], error: null }),
      queryResult({ data: queued, error: null }),
      failureUpdate,
    ]);
    const outbox = new ViptelCommandOutbox(client as never, ids.organization, "listener-1");

    await expect(outbox.dispatchNext(providerSocket(), providerClient(), new Date(NOW))).resolves.toBeNull();

    expect(updatePayload(failureUpdate)).toMatchObject({
      status: "failed",
      provider_response: { reason: "mutation_authority_rejected" },
    });
    expect(failureUpdate.calls).toContainEqual({
      method: "select",
      args: ["id, organization_id, provider, command_type, requested_by, queue_id, extension_id, idempotency_key, request_payload"],
    });
    expect(routingMocks.markFailed).toHaveBeenCalledOnce();
    expect(routingMocks.markFailed).toHaveBeenCalledWith(
      client,
      ids.organization,
      failed,
      expect.stringContaining("payload hash"),
    );
    expect(routingMocks.markFailed.mock.invocationCallOrder[0]).toBeLessThan(
      interlockMocks.releaseTerminal.mock.invocationCallOrder[0],
    );
  });

  it("durably degrades a routing operation when a valid queued command expires", async () => {
    const queued = routingCommand({
      status: "queued",
      createdAt: "2026-08-07T09:54:59.000Z",
      authorityAt: NOW,
    });
    const failed = routingFailureProjection(queued);
    const client = sequentialClient([
      queryResult({ data: [], error: null }),
      queryResult({ data: queued, error: null }),
      queryResult({ data: failed, error: null }),
    ]);
    const outbox = new ViptelCommandOutbox(client as never, ids.organization, "listener-1");

    await expect(outbox.dispatchNext(providerSocket(), providerClient(), new Date(NOW))).resolves.toBeNull();

    expect(routingMocks.markFailed).toHaveBeenCalledWith(
      client,
      ids.organization,
      failed,
      "Príkaz expiroval skôr, než ho listener stihol bezpečne odoslať.",
    );
  });

  it("only degrades timeout candidates actually changed to failed when confirmation wins another CAS", async () => {
    const first = routingCommand({ status: "sent" });
    const second = {
      ...routingCommand({ status: "sent" }),
      id: "55555555-5555-4555-8555-555555555555",
    };
    const firstCandidate = {
      ...routingFailureProjection(first),
      status: "sent",
      provider_response: { listenerInstance: "listener-previous" },
    };
    const confirmationWonCandidate = {
      ...routingFailureProjection(second),
      status: "sent",
      provider_response: { listenerInstance: "listener-previous" },
    };
    const actuallyFailed = {
      ...firstCandidate,
      status: "failed",
      provider_response: {
        deliveryUncertain: true,
        reason: "provider_confirmation_timeout",
      },
    };
    const timeoutUpdate = queryResult({ data: [actuallyFailed], error: null });
    const client = sequentialClient([
      queryResult({ data: [firstCandidate, confirmationWonCandidate], error: null }),
      timeoutUpdate,
      queryResult({ data: null, error: null }),
    ]);
    const outbox = new ViptelCommandOutbox(client as never, ids.organization, "listener-1");

    await expect(outbox.dispatchNext(providerSocket(), providerClient(), new Date(NOW))).resolves.toBeNull();

    expect(timeoutUpdate.calls).toContainEqual({
      method: "in",
      args: ["id", [firstCandidate.id, confirmationWonCandidate.id]],
    });
    expect(timeoutUpdate.calls).toContainEqual({
      method: "select",
      args: ["id, organization_id, provider, command_type, requested_by, queue_id, extension_id, idempotency_key, status, provider_response, request_payload"],
    });
    expect(routingMocks.markFailed).toHaveBeenCalledOnce();
    expect(routingMocks.markFailed).toHaveBeenCalledWith(
      client,
      ids.organization,
      actuallyFailed,
      "VIPTel akciu sa nepodarilo potvrdiť udalosťou.",
    );
    expect(interlockMocks.releaseTerminal).toHaveBeenCalledOnce();
    expect(interlockMocks.releaseTerminal).toHaveBeenCalledWith(
      client,
      ids.organization,
      actuallyFailed.request_payload,
    );
    expect(routingMocks.markFailed).not.toHaveBeenCalledWith(
      client,
      ids.organization,
      expect.objectContaining({ id: confirmationWonCandidate.id }),
      expect.any(String),
    );
  });

  it("idempotently advances an already-confirmed routing command on duplicate provider delivery", async () => {
    const confirmed = routingCommand({ status: "confirmed_by_event" });
    const client = sequentialClient([
      queryResult({ data: [confirmed], error: null }),
    ]);

    await expect(confirmTelephonyCommandsFromViptelEvent(
      client as never,
      ids.organization,
      { event: "queue.add", queue: "601", member: "20" },
      { receivedAt: NOW, eventFingerprint: "duplicate-event" },
    )).resolves.toEqual([confirmed.id]);

    expect(routingMocks.advanceConfirmed).toHaveBeenCalledOnce();
    expect(routingMocks.advanceConfirmed).toHaveBeenCalledWith(client, ids.organization, confirmed);
    expect(routingMocks.markFailed).not.toHaveBeenCalled();
    expect(interlockMocks.releaseTerminal).toHaveBeenCalledWith(
      client,
      ids.organization,
      confirmed.request_payload,
    );
  });

  it("degrades the operation if duplicate confirmation recovery cannot advance", async () => {
    const confirmed = routingCommand({ status: "confirmed_by_event" });
    routingMocks.advanceConfirmed.mockRejectedValueOnce(new Error("routing metadata CAS failed"));
    const client = sequentialClient([
      queryResult({ data: [confirmed], error: null }),
    ]);

    await expect(confirmTelephonyCommandsFromViptelEvent(
      client as never,
      ids.organization,
      { event: "queue.add", queue: "601", member: "20" },
      { receivedAt: NOW },
    )).resolves.toEqual([confirmed.id]);

    expect(routingMocks.markFailed).toHaveBeenCalledWith(
      client,
      ids.organization,
      confirmed,
      "Potvrdený krok sa nepodarilo posunúť: routing metadata CAS failed",
    );
  });
});

function routingCommand(input: {
  status: TelephonyCommandRow["status"];
  createdAt?: string;
  authorityAt?: string;
}): TelephonyCommandRow {
  const requestPayload = {
    action: "add",
    extension: "20",
    queue: "601",
    routingOperation: {
      authorityDigest: "authority-digest",
      operationId: ids.operation,
      revision: 2,
      stepIndex: 0,
    },
  };
  const authorized = authorizeViptelMutationCommand({
    commandId: ids.command,
    commandType: "queue.add",
    executionTarget: "listener_rest",
    idempotencyKey: "routing-step-0",
    organizationId: ids.organization,
    requestPayload,
    requestedBy: ids.profile,
  }, {
    env: { VIPTEL_LIVE_MUTATION_TOKEN: AUTHORITY_TOKEN },
    now: new Date(input.authorityAt ?? NOW),
  });
  const createdAt = input.createdAt ?? NOW;
  return {
    id: ids.command,
    organization_id: ids.organization,
    provider: "viptel",
    command_type: "queue.add",
    requested_by: ids.profile,
    call_id: null,
    queue_id: null,
    extension_id: null,
    request_payload: authorized.requestPayload,
    provider_response: {},
    status: input.status,
    idempotency_key: "routing-step-0",
    created_at: createdAt,
    updated_at: createdAt,
    sent_at: input.status === "queued" ? null : createdAt,
    confirmed_at: input.status === "confirmed_by_event" ? NOW : null,
  };
}

function providerSocket() {
  return { readyState: 1, send: vi.fn() };
}

function routingFailureProjection(command: TelephonyCommandRow) {
  return {
    command_type: command.command_type,
    extension_id: command.extension_id,
    id: command.id,
    idempotency_key: command.idempotency_key,
    organization_id: command.organization_id,
    provider: command.provider,
    queue_id: command.queue_id,
    request_payload: command.request_payload,
    requested_by: command.requested_by,
  };
}

function providerClient() {
  return {
    getQueueStatus: vi.fn(),
    listExtensions: vi.fn(),
    setQueueAgent: vi.fn(),
  };
}

function sequentialClient(results: Array<ReturnType<typeof queryResult>>) {
  let index = 0;
  return {
    from: vi.fn(() => {
      const result = results[index++];
      if (!result) throw new Error(`Unexpected database query ${index}.`);
      return result.query;
    }),
  };
}

function queryResult(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        if (property === "maybeSingle" || property === "single") return Promise.resolve(result);
        return query;
      };
    },
  });
  return { calls, query };
}

function updatePayload(result: ReturnType<typeof queryResult>) {
  return result.calls.find((call) => call.method === "update")?.args[0];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
