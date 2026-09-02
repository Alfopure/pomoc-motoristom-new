import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Json } from "@/lib/supabase/database.types";
import { authorizeViptelMutationCommand } from "./mutation-command-authority";
import {
  signViptelProviderSnapshotRequest,
  VIPTEL_PROVIDER_SNAPSHOT_REQUEST_HMAC_KEY,
} from "./provider-snapshot-bridge";
import type { TelephonyCommandRow } from "./viptel-command-outbox";
import { deterministicAuditReceiptId, ViptelCommandOutbox } from "./viptel-command-outbox";

const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-05T12:00:05.000Z");
const ENV_NAMES = [
  "VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED",
  "VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN",
  "VIPTEL_LIVE_MUTATIONS_ENABLED",
  "VIPTEL_LIVE_MUTATION_TOKEN",
  "VERCEL_ENV",
] as const;
let previousEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  previousEnvironment = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const name of ENV_NAMES) {
    const previous = previousEnvironment[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

describe("VIPTel listener snapshot dispatch", () => {
  it("processes a normalized read snapshot while live mutations are disabled and performs no provider write", async () => {
    enableSnapshotBridge();
    const queued = snapshotCommand("queued");
    const claimed = { ...queued, status: "sent" as const, sent_at: NOW.toISOString() };
    const harness = sequencedClient([[], queued, claimed, ...snapshotClaimResults(claimed), { id: queued.id }]);
    const provider = snapshotProvider();
    const outbox = new ViptelCommandOutbox(harness.client as never, ORGANIZATION, "listener-1");

    await expect(outbox.dispatchNext({ readyState: 0, send: vi.fn() }, provider as never, NOW)).resolves.toEqual({
      commandId: queued.id,
      commandType: "provider.snapshot",
      transport: "rest",
    });

    expect(provider.listExtensions).toHaveBeenCalledOnce();
    expect(provider.listActiveCalls).toHaveBeenCalledOnce();
    expect(provider.getQueueStatus).toHaveBeenCalledTimes(3);
    expect(provider.setQueueAgent).not.toHaveBeenCalled();
    const confirmation = harness.updates.find((value) => asRecord(value).status === "confirmed_by_event");
    expect(confirmation).toBeDefined();
    expect(JSON.stringify(confirmation)).not.toContain("raw-provider-secret");
    expect(JSON.stringify(confirmation)).not.toContain('"raw"');
  });

  it("persists the provider-read completion time instead of the earlier dispatch time", async () => {
    enableSnapshotBridge();
    const completedAt = new Date(NOW.getTime() + 3_000);
    let listenerNow = NOW;
    const queued = snapshotCommand("queued");
    const claimed = { ...queued, status: "sent" as const, sent_at: NOW.toISOString() };
    const harness = sequencedClient([[], queued, claimed, ...snapshotClaimResults(claimed), { id: queued.id }]);
    const provider = snapshotProvider();
    provider.getQueueStatus.mockImplementation(async (queue: string) => {
      if (queue === "603") listenerNow = completedAt;
      return { queue, waitingCalls: 0, members: [] };
    });
    const outbox = new ViptelCommandOutbox(
      harness.client as never,
      ORGANIZATION,
      "listener-1",
      () => listenerNow,
    );

    await expect(outbox.dispatchNext({ readyState: 0, send: vi.fn() }, provider as never, NOW)).resolves.toMatchObject({
      commandId: queued.id,
      commandType: "provider.snapshot",
    });

    const confirmation = asRecord(harness.updates.find((value) => asRecord(value).status === "confirmed_by_event"));
    const response = asRecord(confirmation.provider_response);
    const snapshot = asRecord(response.snapshot);
    expect(snapshot.capturedAt).toBe(completedAt.toISOString());
    expect(response.confirmedAt).toBe(completedAt.toISOString());
  });

  it("does not confirm a provider read that crosses the signed request deadline", async () => {
    enableSnapshotBridge();
    const expiredAt = new Date(NOW.getTime() + 16_000);
    let listenerNow = NOW;
    const queued = snapshotCommand("queued");
    const claimed = { ...queued, status: "sent" as const, sent_at: NOW.toISOString() };
    const harness = sequencedClient([[], queued, claimed, ...snapshotClaimResults(claimed), null]);
    const provider = snapshotProvider();
    provider.getQueueStatus.mockImplementation(async (queue: string) => {
      if (queue === "603") listenerNow = expiredAt;
      return { queue, waitingCalls: 0, members: [] };
    });
    const outbox = new ViptelCommandOutbox(
      harness.client as never,
      ORGANIZATION,
      "listener-1",
      () => listenerNow,
    );

    await expect(outbox.dispatchNext({ readyState: 0, send: vi.fn() }, provider as never, NOW))
      .rejects.toThrow("expired before provider access");
    expect(harness.updates.some((value) => asRecord(value).status === "confirmed_by_event")).toBe(false);
    expect(harness.updates.some((value) => asRecord(value).status === "failed")).toBe(true);
  });

  it("always selects provider mutations before a queued read snapshot when both gates are enabled", async () => {
    enableSnapshotBridge();
    enableLiveMutations();
    const guard = assignmentGuard();
    const queued = callCommand("queued", guard);
    const claimed = { ...queued, status: "sent" as const, sent_at: NOW.toISOString() };
    const currentAssignment = {
      id: guard.extensionId,
      extension: guard.extension,
      profile_id: guard.profileId,
      active: true,
      metadata: {
        assignmentLifecycle: assignmentLifecycle(),
        assignmentGeneration: guard.generation,
        assignmentActionClaim: {
          action: "call.create",
          claimId: guard.claimId,
          generation: guard.generation,
          lifecycleEpoch: guard.lifecycleEpoch,
          profileId: guard.profileId,
        },
      },
    };
    const harness = sequencedClient([
      [], queued, claimed, ...mutationClaimResults(claimed), currentAssignment,
      assignmentAudit(), { id: ACTOR, phone_extension: "20" }, null,
    ]);
    const provider = snapshotProvider();
    const socket = { readyState: 1, send: vi.fn() };
    const outbox = new ViptelCommandOutbox(harness.client as never, ORGANIZATION, "listener-1");

    await expect(outbox.dispatchNext(socket, provider as never, NOW)).resolves.toMatchObject({
      commandType: "call.create",
      transport: "websocket",
    });
    expect(socket.send).toHaveBeenCalledOnce();
    expect(provider.listExtensions).not.toHaveBeenCalled();
    expect(harness.filters.some((filter) => filter[0] === "in" && filter[1] === "command_type" &&
      Array.isArray(filter[2]) && filter[2].includes("provider.snapshot"))).toBe(false);
  });

  it("does nothing when only the snapshot gate is disabled", async () => {
    const harness = sequencedClient([]);
    const provider = snapshotProvider();
    const outbox = new ViptelCommandOutbox(harness.client as never, ORGANIZATION, "listener-1");

    await expect(outbox.dispatchNext({ readyState: 1, send: vi.fn() }, provider as never, NOW)).resolves.toBeNull();
    expect(harness.client.from).not.toHaveBeenCalled();
    expect(provider.listExtensions).not.toHaveBeenCalled();
  });

  it("fails closed when snapshot completion loses the exact sent-state CAS", async () => {
    enableSnapshotBridge();
    const queued = snapshotCommand("queued");
    const claimed = { ...queued, status: "sent" as const, sent_at: NOW.toISOString() };
    const harness = sequencedClient([[], queued, claimed, ...snapshotClaimResults(claimed), null, null]);
    const outbox = new ViptelCommandOutbox(harness.client as never, ORGANIZATION, "listener-1");

    await expect(outbox.dispatchNext({ readyState: 0, send: vi.fn() }, snapshotProvider() as never, NOW))
      .rejects.toThrow("sent-state CAS");
    expect(harness.filters).toContainEqual(["eq", "sent_at", NOW.toISOString()]);
  });

  it("expires an unclaimed request before any provider read", async () => {
    enableSnapshotBridge();
    const queued = {
      ...snapshotCommand("queued"),
      request_payload: {
        schemaVersion: 1,
        requestedAt: "2026-08-05T11:59:40.000Z",
        deadlineAt: "2026-08-05T11:59:55.000Z",
      } as Json,
    };
    const harness = sequencedClient([[], queued, null]);
    const provider = snapshotProvider();
    const outbox = new ViptelCommandOutbox(harness.client as never, ORGANIZATION, "listener-1");

    await expect(outbox.dispatchNext({ readyState: 0, send: vi.fn() }, provider as never, NOW)).resolves.toBeNull();
    expect(provider.listExtensions).not.toHaveBeenCalled();
    expect(provider.listActiveCalls).not.toHaveBeenCalled();
  });

  it("requires active-call read capability before producing a partial snapshot", async () => {
    enableSnapshotBridge();
    const queued = snapshotCommand("queued");
    const claimed = { ...queued, status: "sent" as const, sent_at: NOW.toISOString() };
    const harness = sequencedClient([[], queued, claimed, ...snapshotClaimResults(claimed), null]);
    const provider = snapshotProvider();
    const outbox = new ViptelCommandOutbox(harness.client as never, ORGANIZATION, "listener-1");

    await expect(outbox.dispatchNext(
      { readyState: 0, send: vi.fn() },
      { getQueueStatus: provider.getQueueStatus, listExtensions: provider.listExtensions, setQueueAgent: provider.setQueueAgent } as never,
      NOW,
    )).rejects.toThrow("complete active-call snapshot");
    expect(provider.listExtensions).not.toHaveBeenCalled();
  });

  it("rejects a replayed snapshot execution claim before every provider read", async () => {
    enableSnapshotBridge();
    const queued = snapshotCommand("queued");
    const claimed = { ...queued, status: "sent" as const, sent_at: NOW.toISOString() };
    const harness = sequencedClient([
      [],
      queued,
      claimed,
      failedQuery({ code: "23505", message: "duplicate snapshot execution claim" }),
      null,
    ]);
    const provider = snapshotProvider();
    const outbox = new ViptelCommandOutbox(harness.client as never, ORGANIZATION, "listener-1");

    await expect(outbox.dispatchNext({ readyState: 0, send: vi.fn() }, provider as never, NOW))
      .rejects.toThrow(/duplicate snapshot execution claim/);
    expect(provider.listExtensions).not.toHaveBeenCalled();
    expect(provider.listActiveCalls).not.toHaveBeenCalled();
    expect(provider.getQueueStatus).not.toHaveBeenCalled();
  });
});

function snapshotCommand(status: "queued" | "sent"): TelephonyCommandRow {
  const row: TelephonyCommandRow = {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: ORGANIZATION,
    provider: "viptel",
    command_type: "provider.snapshot",
    requested_by: ACTOR,
    call_id: null,
    queue_id: null,
    extension_id: null,
    request_payload: {
      schemaVersion: 1,
      requestedAt: "2026-08-05T12:00:00.000Z",
      deadlineAt: "2026-08-05T12:00:15.000Z",
    },
    provider_response: {},
    status,
    idempotency_key: "snapshot-idempotency",
    created_at: "2026-08-05T12:00:00.000Z",
    updated_at: "2026-08-05T12:00:00.000Z",
    sent_at: status === "sent" ? NOW.toISOString() : null,
    confirmed_at: null,
  };
  const requestHmac = signViptelProviderSnapshotRequest(row, ORGANIZATION, {
    VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN: "snapshot-authority-token-at-least-32-characters",
  });
  return {
    ...row,
    request_payload: {
      ...asRecord(row.request_payload),
      [VIPTEL_PROVIDER_SNAPSHOT_REQUEST_HMAC_KEY]: requestHmac,
    } as Json,
  };
}

function callCommand(status: "queued" | "sent", guard: ReturnType<typeof assignmentGuard>): TelephonyCommandRow {
  const base = {
    ...snapshotCommand(status),
    command_type: "call.create",
    extension_id: guard.extensionId,
    requested_by: guard.profileId,
  };
  const authority = authorizeViptelMutationCommand({
    commandId: base.id,
    commandType: "call.create",
    executionTarget: "listener_websocket",
    extensionId: guard.extensionId,
    idempotencyKey: base.idempotency_key,
    organizationId: ORGANIZATION,
    requestPayload: { caller: "20", destination: "23", assignmentGuard: guard },
    requestedBy: guard.profileId,
  }, {
    env: { VIPTEL_LIVE_MUTATION_TOKEN: "mutation-authority-token-at-least-32-characters" },
    now: new Date("2026-08-05T12:00:00.000Z"),
  });
  return { ...base, request_payload: authority.requestPayload };
}

function assignmentGuard() {
  return {
    claimId: "44444444-4444-4444-8444-444444444444",
    extension: "20",
    extensionId: "55555555-5555-4555-8555-555555555555",
    generation: "66666666-6666-4666-8666-666666666666",
    lifecycleEpoch: "77777777-7777-4777-8777-777777777777",
    profileId: ACTOR,
  };
}

function assignmentLifecycle() {
  const guard = assignmentGuard();
  return {
    schemaVersion: 1,
    epoch: guard.lifecycleEpoch,
    state: "assigned",
    extensionId: guard.extensionId,
    extension: guard.extension,
    profileId: guard.profileId,
    assignmentMode: "initial_provisioning",
    assignedAt: "2026-08-04T12:00:00.000Z",
    assignedBy: ACTOR,
  };
}

function assignmentAudit() {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    action: "telephony.extension.assign",
    after_payload: { assignment_lifecycle: assignmentLifecycle() },
    created_at: "2026-08-04T12:00:00.000Z",
  };
}

function snapshotProvider() {
  return {
    listExtensions: vi.fn(async () => ["20", "21", "22", "23"].map((extension) => ({
      extension,
      isRegistered: true,
      isViptelPhoneActive: true,
      allowedChanges: [],
      raw: { ignored: "raw-provider-secret" },
    }))),
    listActiveCalls: vi.fn(async () => []),
    getQueueStatus: vi.fn(async (queue: string) => ({ queue, waitingCalls: 0, members: [] })),
    setQueueAgent: vi.fn(),
  };
}

function enableSnapshotBridge() {
  process.env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED = "true";
  process.env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN = "snapshot-authority-token-at-least-32-characters";
  delete process.env.VERCEL_ENV;
}

function enableLiveMutations() {
  process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
  process.env.VIPTEL_LIVE_MUTATION_TOKEN = "mutation-authority-token-at-least-32-characters";
}

function sequencedClient(results: unknown[]) {
  let index = 0;
  const filters: unknown[][] = [];
  const updates: unknown[] = [];
  const client = { from: vi.fn(() => queryResult(results[index++] ?? null, filters, updates)) };
  return { client, filters, updates };
}

function queryResult(resultData: unknown, filters: unknown[][], updates: unknown[]) {
  const wrapped = asRecord(resultData);
  const result = wrapped.__queryFailure === true
    ? { data: null, error: wrapped.error }
    : { data: resultData, error: null };
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        if (["eq", "in", "lt", "order", "limit"].includes(String(property))) filters.push([property, ...args]);
        if (property === "update") updates.push(args[0]);
        if (property === "maybeSingle" || property === "single") return Promise.resolve(result);
        return query;
      };
    },
  });
  return query;
}

function failedQuery(error: Record<string, unknown>) {
  return { __queryFailure: true, error };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function snapshotClaimResults(command: TelephonyCommandRow) {
  const requestHmac = String(asRecord(command.request_payload)[VIPTEL_PROVIDER_SNAPSHOT_REQUEST_HMAC_KEY]);
  const id = deterministicAuditReceiptId(
    "motorist.viptel.provider-snapshot-execution-claim.v1",
    command.organization_id,
    command.id,
    requestHmac,
  );
  return [
    { id },
    [{
      id,
      after_payload: {
        schemaVersion: 1,
        organizationId: command.organization_id,
        commandId: command.id,
        commandType: "provider.snapshot",
        requestHmac,
        claimedAt: NOW.toISOString(),
        listenerInstance: "listener-1",
      },
    }],
  ];
}

function mutationClaimResults(command: TelephonyCommandRow) {
  const authority = asRecord(asRecord(command.request_payload).listenerMutationAuthority);
  const signature = String(authority.signature);
  const id = deterministicAuditReceiptId(
    "motorist.viptel.listener-mutation-execution-claim.v1",
    command.organization_id,
    command.id,
    signature,
  );
  return [
    { id },
    [{
      id,
      after_payload: {
        schemaVersion: 1,
        organizationId: command.organization_id,
        commandId: command.id,
        commandType: command.command_type,
        authoritySignature: signature,
        payloadHash: authority.payloadHash,
        claimedAt: NOW.toISOString(),
        listenerInstance: "listener-1",
      },
    }],
  ];
}
