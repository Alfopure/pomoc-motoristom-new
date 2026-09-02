import { describe, expect, it } from "vitest";

import type { Json } from "@/lib/supabase/database.types";
import {
  authorizeViptelMutationCommand,
  verifyViptelMutationCommandAuthority,
  verifyViptelMutationCommandIntegrity,
  ViptelMutationAuthorityRejected,
  type ViptelMutationAuthorityCommand,
} from "./mutation-command-authority";

const ENV = { VIPTEL_LIVE_MUTATION_TOKEN: "mutation-authority-token-at-least-32-characters" };
const NOW = new Date("2026-08-05T06:00:00.000Z");
const ids = {
  call: "11111111-1111-4111-8111-111111111111",
  command: "22222222-2222-4222-8222-222222222222",
  extension: "33333333-3333-4333-8333-333333333333",
  organization: "44444444-4444-4444-8444-444444444444",
  profile: "55555555-5555-4555-8555-555555555555",
  queue: "66666666-6666-4666-8666-666666666666",
};

describe("VIPTel listener mutation command authority", () => {
  it("authenticates every provider-relevant column and the complete business payload", () => {
    const command = authorizedCall();
    expect(verifyViptelMutationCommandAuthority(command, ids.organization, NOW, ENV)).toMatchObject({
      executionTarget: "listener_websocket",
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      signature: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const tamperedRows = [
      { ...command, id: "77777777-7777-4777-8777-777777777777" },
      { ...command, organization_id: "77777777-7777-4777-8777-777777777777" },
      { ...command, command_type: "call.redirect" },
      { ...command, requested_by: "77777777-7777-4777-8777-777777777777" },
      { ...command, extension_id: "77777777-7777-4777-8777-777777777777" },
      { ...command, idempotency_key: "copied-signature-new-fence" },
      {
        ...command,
        request_payload: {
          ...record(command.request_payload),
          destination: "+421900999999",
        } as Json,
      },
      {
        ...command,
        request_payload: {
          ...record(command.request_payload),
          assignmentGuard: {
            ...record(record(command.request_payload).assignmentGuard),
            generation: "forged-generation",
          },
        } as Json,
      },
    ];
    for (const tampered of tamperedRows) {
      expect(() => verifyViptelMutationCommandAuthority(tampered, tampered.organization_id, NOW, ENV))
        .toThrow(ViptelMutationAuthorityRejected);
    }
  });

  it("rejects an expired or not-yet-valid authority", () => {
    const command = authorizedCall();
    expect(() => verifyViptelMutationCommandAuthority(
      command,
      ids.organization,
      new Date("2026-08-05T06:01:00.001Z"),
      ENV,
    )).toThrow(/expired or not yet valid/);
    expect(() => verifyViptelMutationCommandAuthority(
      command,
      ids.organization,
      new Date("2026-08-05T05:59:54.999Z"),
      ENV,
    )).toThrow(/expired or not yet valid/);
  });

  it("makes an accepted browser SIP intent correlation-only even after its row is reset to queued", () => {
    const command = authorizedCall("event_correlation_only");
    expect(verifyViptelMutationCommandIntegrity(command, ids.organization, ENV).executionTarget)
      .toBe("event_correlation_only");
    expect(() => verifyViptelMutationCommandAuthority(command, ids.organization, NOW, ENV))
      .toThrow(/not authorized for listener execution/);
  });

  it("requires queue commands to carry the listener REST execution target", () => {
    const command = authorizedQueue();
    expect(verifyViptelMutationCommandAuthority(command, ids.organization, NOW, ENV).executionTarget)
      .toBe("listener_rest");

    const wrongTarget = authorizeViptelMutationCommand({
      commandId: ids.command,
      commandType: "queue.add",
      executionTarget: "listener_websocket",
      extensionId: ids.extension,
      idempotencyKey: "queue-fence",
      organizationId: ids.organization,
      queueId: ids.queue,
      requestPayload: { action: "add", extension: "20", queue: "601" },
      requestedBy: ids.profile,
    }, { env: ENV, now: NOW });
    expect(() => verifyViptelMutationCommandAuthority({
      ...command,
      request_payload: wrongTarget.requestPayload,
    }, ids.organization, NOW, ENV)).toThrow(/not authorized for listener execution/);
  });

  it("fails closed for a missing authority, wrong token, or oversized payload", () => {
    const unsigned = baseCommand({ destination: "+421900000000" });
    expect(() => verifyViptelMutationCommandAuthority(unsigned, ids.organization, NOW, ENV))
      .toThrow(/missing or malformed/);
    expect(() => verifyViptelMutationCommandAuthority(authorizedCall(), ids.organization, NOW, {
      VIPTEL_LIVE_MUTATION_TOKEN: "different-authority-token-at-least-32-characters",
    })).toThrow(/signature is invalid/);
    expect(() => authorizeViptelMutationCommand({
      commandId: ids.command,
      commandType: "call.create",
      executionTarget: "listener_websocket",
      extensionId: ids.extension,
      idempotencyKey: "large-payload",
      organizationId: ids.organization,
      requestPayload: { destination: "9".repeat(70_000) },
      requestedBy: ids.profile,
    }, { env: ENV, now: NOW })).toThrow(/size limit/);
  });

  it("uses key-order-independent canonical JSON", () => {
    const command = authorizedCall();
    const payload = record(command.request_payload);
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as Json;
    expect(verifyViptelMutationCommandAuthority(
      { ...command, request_payload: reordered },
      ids.organization,
      NOW,
      ENV,
    )).toMatchObject({ executionTarget: "listener_websocket" });
  });

  it("rejects payloads that exceed canonical depth or node limits", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 40; depth += 1) nested = { nested };
    expect(() => authorizeViptelMutationCommand({
      commandId: ids.command,
      commandType: "call.create",
      executionTarget: "listener_websocket",
      extensionId: ids.extension,
      idempotencyKey: "deep-payload",
      organizationId: ids.organization,
      requestPayload: nested,
      requestedBy: ids.profile,
    }, { env: ENV, now: NOW })).toThrow(/canonicalization limits/);

    expect(() => authorizeViptelMutationCommand({
      commandId: ids.command,
      commandType: "call.create",
      executionTarget: "listener_websocket",
      extensionId: ids.extension,
      idempotencyKey: "many-nodes",
      organizationId: ids.organization,
      requestPayload: { nodes: Array.from({ length: 4_100 }, () => 1) },
      requestedBy: ids.profile,
    }, { env: ENV, now: NOW })).toThrow(/canonicalization limits/);
  });
});

function authorizedCall(executionTarget: "event_correlation_only" | "listener_websocket" = "listener_websocket") {
  const businessPayload = {
    caller: "20",
    destination: "+421900000000",
    transport: executionTarget === "event_correlation_only" ? "browser_sip" : "outbox_websocket",
    assignmentGuard: {
      claimId: "77777777-7777-4777-8777-777777777777",
      extension: "20",
      extensionId: ids.extension,
      generation: "88888888-8888-4888-8888-888888888888",
      profileId: ids.profile,
    },
  };
  const authorized = authorizeViptelMutationCommand({
    callId: ids.call,
    commandId: ids.command,
    commandType: "call.create",
    executionTarget,
    extensionId: ids.extension,
    idempotencyKey: "call-fence",
    organizationId: ids.organization,
    requestPayload: businessPayload,
    requestedBy: ids.profile,
  }, { env: ENV, now: NOW });
  return {
    ...baseCommand(authorized.requestPayload),
    call_id: ids.call,
    request_payload: authorized.requestPayload,
  };
}

function authorizedQueue() {
  const authorized = authorizeViptelMutationCommand({
    commandId: ids.command,
    commandType: "queue.add",
    executionTarget: "listener_rest",
    extensionId: ids.extension,
    idempotencyKey: "queue-fence",
    organizationId: ids.organization,
    queueId: ids.queue,
    requestPayload: { action: "add", extension: "20", queue: "601" },
    requestedBy: ids.profile,
  }, { env: ENV, now: NOW });
  return {
    ...baseCommand(authorized.requestPayload),
    command_type: "queue.add",
    queue_id: ids.queue,
    request_payload: authorized.requestPayload,
    idempotency_key: "queue-fence",
  };
}

function baseCommand(requestPayload: unknown): ViptelMutationAuthorityCommand {
  return {
    id: ids.command,
    organization_id: ids.organization,
    provider: "viptel",
    command_type: "call.create",
    requested_by: ids.profile,
    call_id: null,
    queue_id: null,
    extension_id: ids.extension,
    request_payload: requestPayload as Json,
    idempotency_key: "call-fence",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
