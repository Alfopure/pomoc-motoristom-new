import { describe, expect, it, vi } from "vitest";

import type { Json } from "@/lib/supabase/database.types";
import { dispatchRoutingCommittedPlanDigest } from "./dispatch-routing";
import { authorizeViptelMutationCommand, VIPTEL_MUTATION_AUTHORITY_KEY } from "./mutation-command-authority";
import type { TelephonyCommandRow } from "./viptel-command-outbox";
import {
  buildViptelWebSocketAction,
  commandMatchesViptelEvent,
  deterministicAuditReceiptId,
  ViptelCommandOutbox,
} from "./viptel-command-outbox";

function command(commandType: string, requestPayload: Record<string, unknown>): TelephonyCommandRow {
  const guard = asRecord(requestPayload.assignmentGuard);
  const extensionId = typeof guard.extensionId === "string" ? guard.extensionId : null;
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "22222222-2222-4222-8222-222222222222",
    provider: "viptel",
    command_type: commandType,
    requested_by: "33333333-3333-4333-8333-333333333333",
    call_id: null,
    queue_id: null,
    extension_id: extensionId,
    request_payload: requestPayload as Json,
    provider_response: {},
    status: "sent" as const,
    idempotency_key: "abc123",
    created_at: "2026-07-26T08:00:00.000Z",
    updated_at: "2026-07-26T08:00:00.000Z",
    sent_at: "2026-07-26T08:00:00.000Z",
    confirmed_at: null,
  };
  const authority = authorizeViptelMutationCommand({
    commandId: base.id,
    commandType,
    executionTarget: requestPayload.transport === "browser_sip"
      ? "event_correlation_only"
      : commandType.startsWith("queue.") ? "listener_rest" : "listener_websocket",
    idempotencyKey: base.idempotency_key,
    extensionId: base.extension_id,
    organizationId: base.organization_id,
    requestPayload,
    requestedBy: base.requested_by,
  }, {
    env: { VIPTEL_LIVE_MUTATION_TOKEN: "test-authority-token-at-least-32-characters" },
    now: new Date(base.created_at),
  });
  return { ...base, request_payload: authority.requestPayload };
}

describe("VIPTel command protocol", () => {
  it("does not claim or dispatch queued work while the central live-mutation gate is disabled", async () => {
    const previousEnabled = process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
    const previousToken = process.env.VIPTEL_LIVE_MUTATION_TOKEN;
    const previousBridgeEnabled = process.env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED;
    const previousBridgeToken = process.env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN;
    delete process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
    delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
    delete process.env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED;
    delete process.env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN;
    const client = { from: vi.fn() };
    const socket = { readyState: 1, send: vi.fn() };
    const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), setQueueAgent: vi.fn() };
    const outbox = new ViptelCommandOutbox(client as never, "organization-1", "listener-1");

    try {
      await expect(outbox.dispatchNext(socket, viptel)).resolves.toBeNull();
      expect(client.from).not.toHaveBeenCalled();
      expect(socket.send).not.toHaveBeenCalled();
      expect(viptel.setQueueAgent).not.toHaveBeenCalled();
    } finally {
      restoreEnvironment("VIPTEL_LIVE_MUTATIONS_ENABLED", previousEnabled);
      restoreEnvironment("VIPTEL_LIVE_MUTATION_TOKEN", previousToken);
      restoreEnvironment("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED", previousBridgeEnabled);
      restoreEnvironment("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN", previousBridgeToken);
    }
  });

  it("fails a queued command outside queues 601-603 without a provider write", async () => {
    const previousEnabled = process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
    const previousToken = process.env.VIPTEL_LIVE_MUTATION_TOKEN;
    const previousVercelEnv = process.env.VERCEL_ENV;
    process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
    process.env.VIPTEL_LIVE_MUTATION_TOKEN = "test-authority-token-at-least-32-characters";
    delete process.env.VERCEL_ENV;

    const queued = {
      ...command("queue.add", { queue: "500", extension: "20", action: "add" }),
      status: "queued" as const,
      sent_at: null,
    };
    const claimed = { ...queued, status: "sent" as const, sent_at: "2026-07-26T08:00:10.000Z" };
    const results = [
      queryResult({ data: [], error: null }),
      queryResult({ data: queued, error: null }),
      queryResult({ data: claimed, error: null }),
      ...executionClaimResults(claimed),
      queryResult({ data: null, error: null }),
    ];
    let resultIndex = 0;
    const client = { from: vi.fn(() => results[resultIndex++].query) };
    const socket = { readyState: 1, send: vi.fn() };
    const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), setQueueAgent: vi.fn() };
    const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

    try {
      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:10.000Z"))).rejects.toMatchObject({
        message: expect.stringContaining("mimo riadených radov 601–603"),
      });
      expect(viptel.setQueueAgent).not.toHaveBeenCalled();
      expect(viptel.getQueueStatus).not.toHaveBeenCalled();
      expect(viptel.listExtensions).not.toHaveBeenCalled();
      expect(socket.send).not.toHaveBeenCalled();
    } finally {
      restoreEnvironment("VIPTEL_LIVE_MUTATIONS_ENABLED", previousEnabled);
      restoreEnvironment("VIPTEL_LIVE_MUTATION_TOKEN", previousToken);
      restoreEnvironment("VERCEL_ENV", previousVercelEnv);
    }
  });

  it("does not write to VIPTel if claimed availability ownership changed", async () => {
    await withLiveMutations(async () => {
      const queued = availabilityCommand("queued");
      const claimed = availabilityCommand("sent");
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        ...executionClaimResults(claimed),
        queryResult({ data: dispatchRootQueue(), error: null }),
        committedRoutingAudit(),
        queryResult({ data: null, error: null }),
        queryResult({ data: null, error: null }),
      ];
      let resultIndex = 0;
      const client = { from: vi.fn(() => results[resultIndex++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), setQueueAgent: vi.fn() };
      const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:10.000Z"))).rejects.toMatchObject({
        message: expect.stringContaining("nepatrí pôvodnému operátorovi"),
      });
      expect(viptel.getQueueStatus).not.toHaveBeenCalled();
      expect(viptel.setQueueAgent).not.toHaveBeenCalled();
    });
  });

  it("does not write to VIPTel if exact live membership no longer matches the action", async () => {
    await withLiveMutations(async () => {
      const queued = availabilityCommand("queued");
      const claimed = availabilityCommand("sent");
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        ...executionClaimResults(claimed),
        queryResult({ data: dispatchRootQueue(), error: null }),
        committedRoutingAudit(),
        queryResult({ data: { id: assignmentGuard().extensionId }, error: null }),
        queryResult({ data: [{ id: queued.id, request_payload: queued.request_payload }], error: null }),
        currentAvailabilityAssignment(),
        ...assignmentLifecycleResults(),
        queryResult({ data: null, error: null }),
      ];
      let resultIndex = 0;
      const client = { from: vi.fn(() => results[resultIndex++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = {
        getQueueStatus: vi.fn(async (queue: string) => ({
          queue,
          waitingCalls: 0,
          members: queue === "601"
            ? [{ extension: "20", paused: false, inUse: false, dynamic: true, callsTaken: 0 }]
            : [],
        })),
        listExtensions: vi.fn(async () => [{
          extension: "20",
          isRegistered: true,
          allowedChanges: [],
          raw: {},
        }]),
        setQueueAgent: vi.fn(),
      };
      const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:10.000Z"))).rejects.toMatchObject({
        message: expect.stringContaining("už nezodpovedá kroku add"),
      });
      expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
      expect(viptel.getQueueStatus).toHaveBeenCalledWith("601");
      expect(viptel.getQueueStatus).toHaveBeenCalledWith("602");
      expect(viptel.getQueueStatus).toHaveBeenCalledWith("603");
      expect(viptel.setQueueAgent).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["extension", "duplicitný alebo konfliktný záznam klapky 20"],
    ["member", "duplicitné alebo konfliktné členstvo 601/20"],
  ] as const)("does not write to VIPTel when the controlled snapshot duplicates a provider %s row", async (duplicate, message) => {
    await withLiveMutations(async () => {
      const queued = availabilityCommand("queued");
      const claimed = availabilityCommand("sent");
      const extension = {
        extension: "20",
        isRegistered: true,
        allowedChanges: [],
        raw: {},
      };
      const member = { extension: "20", paused: false, inUse: false, dynamic: true, callsTaken: 0 };
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        ...executionClaimResults(claimed),
        queryResult({ data: dispatchRootQueue(), error: null }),
        committedRoutingAudit(),
        queryResult({ data: { id: assignmentGuard().extensionId }, error: null }),
        queryResult({ data: [{ id: queued.id, request_payload: queued.request_payload }], error: null }),
        currentAvailabilityAssignment(),
        ...assignmentLifecycleResults(),
        queryResult({ data: null, error: null }),
      ];
      let resultIndex = 0;
      const client = { from: vi.fn(() => results[resultIndex++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = {
        listExtensions: vi.fn(async () => duplicate === "extension" ? [extension, { ...extension }] : [extension]),
        getQueueStatus: vi.fn(async (queue: string) => ({
          queue,
          waitingCalls: 0,
          members: duplicate === "member" && queue === "601" ? [member, { ...member }] : [],
        })),
        setQueueAgent: vi.fn(),
      };
      const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:10.000Z"))).rejects.toThrow(message);
      expect(viptel.listExtensions).toHaveBeenCalledTimes(1);
      expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
      expect(viptel.setQueueAgent).not.toHaveBeenCalled();
    });
  });

  it("stops a claimed availability command when assignment changes before provider access", async () => {
    await withLiveMutations(async () => {
      const queued = availabilityCommand("queued");
      const claimed = availabilityCommand("sent");
      const guard = assignmentGuard();
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        ...executionClaimResults(claimed),
        queryResult({ data: dispatchRootQueue(), error: null }),
        committedRoutingAudit(),
        queryResult({ data: { id: guard.extensionId }, error: null }),
        queryResult({ data: [{ id: queued.id, request_payload: queued.request_payload }], error: null }),
        queryResult({
          data: {
            id: guard.extensionId,
            extension: guard.extension,
            profile_id: guard.profileId,
            active: true,
            metadata: {
              assignmentLifecycle: assignmentLifecycle(),
              assignmentGeneration: "changed-generation",
              assignmentActionClaim: {
                claimId: guard.claimId,
                generation: "changed-generation",
                lifecycleEpoch: guard.lifecycleEpoch,
                profileId: guard.profileId,
              },
            },
          },
          error: null,
        }),
        ...assignmentLifecycleResults(),
        queryResult({ data: null, error: null }),
      ];
      let resultIndex = 0;
      const client = { from: vi.fn(() => results[resultIndex++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), setQueueAgent: vi.fn() };
      const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:10.000Z"))).rejects.toThrow(
        "Vlastníctvo alebo generácia",
      );
      expect(viptel.listExtensions).not.toHaveBeenCalled();
      expect(viptel.getQueueStatus).not.toHaveBeenCalled();
      expect(viptel.setQueueAgent).not.toHaveBeenCalled();
    });
  });

  it("revalidates the exact assignment generation immediately before a call provider write", async () => {
    await withLiveMutations(async () => {
      const guard = assignmentGuard();
      const queued = {
        ...command("call.create", {
          assignmentGuard: guard,
          caller: "20",
          destination: "00421900111222",
        }),
        extension_id: guard.extensionId,
        status: "queued" as const,
        sent_at: null,
      };
      const claimed = { ...queued, status: "sent" as const, sent_at: "2026-07-26T08:00:10.000Z" };
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        ...executionClaimResults(claimed),
        queryResult({
          data: {
            id: guard.extensionId,
            extension: "20",
            profile_id: guard.profileId,
            active: true,
            metadata: {
              assignmentLifecycle: assignmentLifecycle(),
              assignmentGeneration: "99999999-9999-4999-8999-999999999999",
              assignmentActionClaim: guard,
            },
          },
          error: null,
        }),
        ...assignmentLifecycleResults(),
        queryResult({ data: null, error: null }),
      ];
      let resultIndex = 0;
      const client = { from: vi.fn(() => results[resultIndex++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), setQueueAgent: vi.fn() };
      const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:10.000Z"))).rejects.toThrow(
        "Vlastníctvo alebo generácia",
      );
      expect(socket.send).not.toHaveBeenCalled();
    });
  });

  it("rejects a duplicate immutable execution claim before any provider or socket write", async () => {
    await withLiveMutations(async () => {
      const guard = assignmentGuard();
      const queued = {
        ...command("call.hangup", { assignmentGuard: guard, uniqueId: "1453223070.4" }),
        status: "queued" as const,
        sent_at: null,
      };
      const claimed = { ...queued, status: "sent" as const, sent_at: "2026-07-26T08:00:10.000Z" };
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        queryResult({ data: null, error: { code: "23505", message: "duplicate execution claim" } }),
        queryResult({ data: null, error: null }),
      ];
      let index = 0;
      const client = { from: vi.fn(() => results[index++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), listActiveCalls: vi.fn(), setQueueAgent: vi.fn() };
      const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

      await expect(outbox.dispatchNext(socket, viptel as never, new Date("2026-07-26T08:00:10.000Z")))
        .rejects.toThrow(/duplicate execution claim/);
      expect(socket.send).not.toHaveBeenCalled();
      expect(viptel.listActiveCalls).not.toHaveBeenCalled();
      expect(viptel.setQueueAgent).not.toHaveBeenCalled();
    });
  });

  it("rejects a signed payload swapped by the queued-to-sent CAS", async () => {
    await withLiveMutations(async () => {
      const guard = assignmentGuard();
      const queued = {
        ...command("call.hangup", { assignmentGuard: guard, uniqueId: "1453223070.4" }),
        status: "queued" as const,
        sent_at: null,
      };
      const claimed = {
        ...queued,
        status: "sent" as const,
        sent_at: "2026-07-26T08:00:10.000Z",
        request_payload: {
          ...asRecord(queued.request_payload),
          uniqueId: "1453223070.forged",
        } as Json,
      };
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        queryResult({ data: null, error: null }),
      ];
      let index = 0;
      const client = { from: vi.fn(() => results[index++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), listActiveCalls: vi.fn(), setQueueAgent: vi.fn() };
      const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

      await expect(outbox.dispatchNext(socket, viptel as never, new Date("2026-07-26T08:00:10.000Z")))
        .rejects.toThrow(/payload hash does not match/);
      expect(socket.send).not.toHaveBeenCalled();
      expect(viptel.listActiveCalls).not.toHaveBeenCalled();
      expect(viptel.setQueueAgent).not.toHaveBeenCalled();
    });
  });

  it("rechecks the live authority deadline immediately before provider I/O", async () => {
    await withLiveMutations(async () => {
      const guard = assignmentGuard();
      const queued = {
        ...command("call.hangup", { assignmentGuard: guard, uniqueId: "1453223070.4" }),
        status: "queued" as const,
        sent_at: null,
      };
      const claimed = { ...queued, status: "sent" as const, sent_at: "2026-07-26T08:00:10.000Z" };
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        ...executionClaimResults(claimed),
        currentAvailabilityAssignment(),
        ...assignmentLifecycleResults(),
        queryResult({ data: null, error: null }),
      ];
      let index = 0;
      const client = { from: vi.fn(() => results[index++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), listActiveCalls: vi.fn(), setQueueAgent: vi.fn() };
      const outbox = new ViptelCommandOutbox(
        client as never,
        queued.organization_id,
        "listener-1",
        () => new Date("2026-07-26T08:01:10.000Z"),
      );

      await expect(outbox.dispatchNext(socket, viptel as never, new Date("2026-07-26T08:00:10.000Z")))
        .rejects.toThrow(/expired or not yet valid/);
      expect(socket.send).not.toHaveBeenCalled();
      expect(viptel.listActiveCalls).not.toHaveBeenCalled();
      expect(viptel.setQueueAgent).not.toHaveBeenCalled();
    });
  });

  it("sends a call only while the exact assignment guard is still current", async () => {
    await withLiveMutations(async () => {
      const guard = assignmentGuard();
      const queued = {
        ...command("call.hangup", {
          assignmentGuard: guard,
          uniqueId: "1453223070.4",
        }),
        extension_id: guard.extensionId,
        status: "queued" as const,
        sent_at: null,
      };
      const claimed = { ...queued, status: "sent" as const, sent_at: "2026-07-26T08:00:10.000Z" };
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        ...executionClaimResults(claimed),
        queryResult({
          data: {
            id: guard.extensionId,
            extension: guard.extension,
            profile_id: guard.profileId,
            active: true,
            metadata: {
              assignmentLifecycle: assignmentLifecycle(),
              assignmentGeneration: guard.generation,
              assignmentActionClaim: {
                action: "call.hangup",
                claimId: guard.claimId,
                generation: guard.generation,
                lifecycleEpoch: guard.lifecycleEpoch,
                profileId: guard.profileId,
              },
            },
          },
          error: null,
        }),
        ...assignmentLifecycleResults(),
        queryResult({ data: null, error: null }),
      ];
      let resultIndex = 0;
      const client = { from: vi.fn(() => results[resultIndex++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), setQueueAgent: vi.fn() };
      const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:10.000Z"))).resolves.toMatchObject({
        commandId: queued.id,
        transport: "websocket",
      });
      expect(socket.send).toHaveBeenCalledTimes(1);
    });
  });

  it("starts the websocket response window at the actual provider send time", async () => {
    await withLiveMutations(async () => {
      const guard = assignmentGuard();
      const queued = {
        ...command("call.hangup", { assignmentGuard: guard, uniqueId: "1453223070.4" }),
        extension_id: guard.extensionId,
        status: "queued" as const,
        sent_at: null,
      };
      const claimed = { ...queued, status: "sent" as const, sent_at: "2026-07-26T08:00:10.000Z" };
      const markSocketSent = queryResult({ data: null, error: null });
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        ...executionClaimResults(claimed),
        currentCallAssignment(),
        ...assignmentLifecycleResults(),
        markSocketSent,
        queryResult({ data: [], error: null }),
      ];
      let resultIndex = 0;
      const client = { from: vi.fn(() => results[resultIndex++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), setQueueAgent: vi.fn() };
      let clockRead = 0;
      const outbox = new ViptelCommandOutbox(
        client as never,
        queued.organization_id,
        "listener-1",
        () => new Date(clockRead++ === 0 ? "2026-07-26T08:00:19.000Z" : "2026-07-26T08:00:20.000Z"),
      );

      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:10.000Z")))
        .resolves.toMatchObject({ commandId: queued.id, transport: "websocket" });
      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:27.000Z"))).resolves.toBeNull();

      expect(socket.send).toHaveBeenCalledTimes(1);
      expect(client.from).toHaveBeenCalledTimes(results.length);
      expect(markSocketSent.calls).toContainEqual({
        method: "update",
        args: [{
          provider_response: expect.objectContaining({ sentAt: "2026-07-26T08:00:20.000Z" }),
        }],
      });
    });
  });

  it("marks a successful websocket send as delivery-uncertain when its DB receipt fails", async () => {
    await withLiveMutations(async () => {
      const guard = assignmentGuard();
      const queued = {
        ...command("call.hangup", { assignmentGuard: guard, uniqueId: "1453223070.4" }),
        extension_id: guard.extensionId,
        status: "queued" as const,
        sent_at: null,
      };
      const claimed = { ...queued, status: "sent" as const, sent_at: "2026-07-26T08:00:10.000Z" };
      const failedReceipt = queryResult({ data: null, error: { message: "socket receipt write failed" } });
      const failedCommand = queryResult({ data: null, error: null });
      const results = [
        queryResult({ data: [], error: null }),
        queryResult({ data: queued, error: null }),
        queryResult({ data: claimed, error: null }),
        ...executionClaimResults(claimed),
        currentCallAssignment(),
        ...assignmentLifecycleResults(),
        failedReceipt,
        failedCommand,
      ];
      let resultIndex = 0;
      const client = { from: vi.fn(() => results[resultIndex++].query) };
      const socket = { readyState: 1, send: vi.fn() };
      const viptel = { getQueueStatus: vi.fn(), listExtensions: vi.fn(), setQueueAgent: vi.fn() };
      const outbox = new ViptelCommandOutbox(client as never, queued.organization_id, "listener-1");

      await expect(outbox.dispatchNext(socket, viptel, new Date("2026-07-26T08:00:10.000Z")))
        .rejects.toThrow("socket receipt write failed");
      expect(socket.send).toHaveBeenCalledTimes(1);
      expect(failedCommand.calls).toContainEqual({
        method: "update",
        args: [{
          status: "failed",
          provider_response: expect.objectContaining({ deliveryUncertain: true }),
        }],
      });
    });
  });

  it("builds the documented call.create action with a provider correlation id", () => {
    expect(buildViptelWebSocketAction(command("call.create", {
      caller: "12",
      destination: "00421900111222",
      requestedCallerId: "0412289133",
    }))).toEqual({
      action: "call.create",
      from: "12",
      to: "00421900111222",
      call_random_id: "abc123",
      caller_id: "0412289133",
    });
  });

  it("builds exact hangup and redirect actions", () => {
    expect(buildViptelWebSocketAction(command("call.hangup", { uniqueId: "1453223070.4" }))).toEqual({
      action: "call.hangup",
      unique_id: "1453223070.4",
    });
    expect(buildViptelWebSocketAction(command("call.redirect", {
      uniqueId: "1453223070.4",
      destinationExtension: "13",
    }))).toEqual({
      action: "call.redirect",
      unique_id: "1453223070.4",
      destination: "13",
    });
    expect(buildViptelWebSocketAction(command("call.redirect", {
      uniqueId: "1453223070.4",
      destination: "00420777111222",
    }))).toEqual({
      action: "call.redirect",
      unique_id: "1453223070.4",
      destination: "00420777111222",
    });
  });

  it("confirms a logical hangup from either the queue parent or its current agent leg", () => {
    const row = command("call.hangup", {
      uniqueId: "queue-parent.1",
      confirmationUniqueIds: ["queue-parent.1", "agent-leg.2"],
    });

    expect(commandMatchesViptelEvent(row, {
      event: "call.end",
      data: { unique_id: "agent-leg.2" },
    })).toBe(true);
    expect(commandMatchesViptelEvent(row, {
      event: "call.end",
      data: { unique_id: "different-call.9" },
    })).toBe(false);
  });

  it("confirms API-created calls only by the matching call_random_id", () => {
    const row = command("call.create", { caller: "12", destination: "00421900111222" });
    expect(commandMatchesViptelEvent(row, {
      event: "call.create_response",
      unique_id: "14549.678",
      call_random_id: "abc123",
    })).toBe(true);
    expect(commandMatchesViptelEvent(row, {
      event: "call.create_response",
      unique_id: "14549.679",
      call_random_id: "another",
    })).toBe(false);
  });

  it("confirms a browser SIP intent from the matching provider call.begin event", () => {
    const row = command("call.create", {
      caller: "12",
      destination: "00421900111222",
      transport: "browser_sip",
    });
    expect(commandMatchesViptelEvent(row, {
      event: "call.begin",
      caller: "12",
      callee: "+421900111222",
      unique_id: "14549.680",
    })).toBe(true);
    expect(commandMatchesViptelEvent(row, {
      event: "call.begin",
      caller: "13",
      callee: "+421900111222",
      unique_id: "14549.681",
    })).toBe(false);
    expect(commandMatchesViptelEvent(row, {
      event: "call.begin",
      caller: "+421900999999",
      caller_extension: "12",
      callee: "+421900111222",
      unique_id: "14549.682",
    })).toBe(true);
  });

  it("matches queue confirmations by action, queue and exact member", () => {
    const row = command("queue.pause", { queue: "500", extension: "12" });
    expect(commandMatchesViptelEvent(row, { event: "queue.pause", queue: 500, member: "12" })).toBe(true);
    expect(commandMatchesViptelEvent(row, { event: "queue.pause", queue: 500, member: "13" })).toBe(false);
  });

  it("does not confirm a transfer for an unrelated destination", () => {
    const row = command("call.redirect", { uniqueId: "1453223070.4", destinationExtension: "13" });
    expect(commandMatchesViptelEvent(row, {
      event: "call.begin",
      unique_id: "1453223070.4",
      caller: "12",
      callee: "13",
    })).toBe(true);
    expect(commandMatchesViptelEvent(row, {
      event: "call.begin",
      unique_id: "1453223070.4",
      caller: "12",
      callee: "14",
    })).toBe(false);
  });

  it("confirms an external redirect even when VIPTel reports the number in another dial format", () => {
    const row = command("call.redirect", { uniqueId: "1453223070.4", destination: "0900111222" });
    expect(commandMatchesViptelEvent(row, {
      event: "call.begin",
      from_queue_unique_id: "1453223070.4",
      unique_id: "1453223070.5",
      caller: "12",
      callee: "+421900111222",
    })).toBe(true);
  });

  it("does not claim a redirect succeeded when the call only left its queue", () => {
    const row = command("call.redirect", {
      uniqueId: "agent-leg.2",
      confirmationUniqueIds: ["queue-leg.1", "agent-leg.2"],
      destinationExtension: "21",
    });
    expect(commandMatchesViptelEvent(row, {
      event: "queue.left",
      queue: "601",
      unique_id: "queue-leg.1",
    })).toBe(false);
    expect(commandMatchesViptelEvent(row, {
      event: "queue.left",
      queue: "601",
      unique_id: "another-call.9",
    })).toBe(false);
  });
});

function queryResult(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
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

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withLiveMutations(run: () => Promise<void>) {
  const previousEnabled = process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
  const previousToken = process.env.VIPTEL_LIVE_MUTATION_TOKEN;
  const previousVercelEnv = process.env.VERCEL_ENV;
  process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
  process.env.VIPTEL_LIVE_MUTATION_TOKEN = "test-authority-token-at-least-32-characters";
  delete process.env.VERCEL_ENV;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-26T08:00:10.000Z"));
  try {
    await run();
  } finally {
    vi.useRealTimers();
    restoreEnvironment("VIPTEL_LIVE_MUTATIONS_ENABLED", previousEnabled);
    restoreEnvironment("VIPTEL_LIVE_MUTATION_TOKEN", previousToken);
    restoreEnvironment("VERCEL_ENV", previousVercelEnv);
  }
}

function availabilityCommand(status: "queued" | "sent"): TelephonyCommandRow {
  const guard = assignmentGuard();
  return {
    ...command("queue.add", {
      queue: "601",
      extension: "20",
      action: "add",
      assignmentGuard: guard,
      routingAvailability: {
        kind: "availability",
        queue: "601",
        extension: "20",
        revision: 2,
        intent: "available",
        planDigest: committedPlanDigest(),
      },
    }),
    extension_id: guard.extensionId,
    requested_by: guard.profileId,
    status,
    sent_at: status === "sent" ? "2026-07-26T08:00:10.000Z" : null,
  };
}

function currentAvailabilityAssignment() {
  const guard = assignmentGuard();
  return queryResult({
    data: {
      id: guard.extensionId,
      extension: guard.extension,
      profile_id: guard.profileId,
      active: true,
      metadata: {
        assignmentLifecycle: assignmentLifecycle(),
        assignmentGeneration: guard.generation,
        assignmentActionClaim: {
          action: "queue.availability",
          claimId: guard.claimId,
          generation: guard.generation,
          lifecycleEpoch: guard.lifecycleEpoch,
          profileId: guard.profileId,
        },
      },
    },
    error: null,
  });
}

function currentCallAssignment() {
  const guard = assignmentGuard();
  return queryResult({
    data: {
      id: guard.extensionId,
      extension: guard.extension,
      profile_id: guard.profileId,
      active: true,
      metadata: {
        assignmentLifecycle: assignmentLifecycle(),
        assignmentGeneration: guard.generation,
        assignmentActionClaim: {
          action: "call.hangup",
          claimId: guard.claimId,
          generation: guard.generation,
          lifecycleEpoch: guard.lifecycleEpoch,
          profileId: guard.profileId,
        },
      },
    },
    error: null,
  });
}

function dispatchRootQueue() {
  return {
    id: "queue-row-601",
    external_id: "601",
    line_id: null,
    updated_at: "2026-07-26T08:00:00.000Z",
    metadata: {
      dispatchRouting: {
        revision: 2,
        currentPlan: { "601": "20", "602": "21", "603": "22" },
      },
    },
  };
}

function assignmentGuard() {
  return {
    claimId: "44444444-4444-4444-8444-444444444444",
    extension: "20",
    extensionId: "55555555-5555-4555-8555-555555555555",
    generation: "66666666-6666-4666-8666-666666666666",
    lifecycleEpoch: "77777777-7777-4777-8777-777777777777",
    profileId: "33333333-3333-4333-8333-333333333333",
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
    assignedAt: "2026-07-25T08:00:00.000Z",
    assignedBy: guard.profileId,
  };
}

function assignmentLifecycleResults() {
  const guard = assignmentGuard();
  return [
    queryResult({
      data: {
        id: "88888888-8888-4888-8888-888888888888",
        action: "telephony.extension.assign",
        after_payload: { assignment_lifecycle: assignmentLifecycle() },
        created_at: "2026-07-25T08:00:00.000Z",
      },
      error: null,
    }),
    queryResult({ data: { id: guard.profileId, phone_extension: guard.extension }, error: null }),
  ];
}

function committedPlanDigest() {
  return dispatchRoutingCommittedPlanDigest(
    "22222222-2222-4222-8222-222222222222",
    "queue-row-601",
    {
      revision: 2,
      currentPlan: { "601": "20", "602": "21", "603": "22" },
    },
  );
}

function committedRoutingAudit() {
  return queryResult({
    data: [{
      id: "99999999-9999-4999-8999-999999999999",
      action: "telephony.routing.plan.committed",
      entity_id: "queue-row-601",
      created_at: "2026-07-25T09:00:00.000Z",
      after_payload: {
        routing_plan_commit: {
          schemaVersion: 1,
          organizationId: "22222222-2222-4222-8222-222222222222",
          rootId: "queue-row-601",
          operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          revision: 2,
          currentPlan: { "601": "20", "602": "21", "603": "22" },
          digest: committedPlanDigest(),
        },
      },
    }],
    error: null,
  });
}

function executionClaimResults(command: TelephonyCommandRow) {
  const envelope = asRecord(asRecord(command.request_payload)[VIPTEL_MUTATION_AUTHORITY_KEY]);
  const signature = String(envelope.signature);
  const claimId = deterministicAuditReceiptId(
    "motorist.viptel.listener-mutation-execution-claim.v1",
    command.organization_id,
    command.id,
    signature,
  );
  return [
    queryResult({ data: { id: claimId }, error: null }),
    queryResult({
      data: [{
        id: claimId,
        after_payload: {
          schemaVersion: 1,
          organizationId: command.organization_id,
          commandId: command.id,
          commandType: command.command_type,
          authoritySignature: signature,
          payloadHash: envelope.payloadHash,
          claimedAt: "2026-07-26T08:00:10.000Z",
          listenerInstance: "listener-1",
        },
      }],
      error: null,
    }),
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
