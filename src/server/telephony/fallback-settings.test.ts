import { describe, expect, it } from "vitest";

import {
  fallbackCallElapsedMs,
  fallbackCommandMarker,
  isSystemFallbackRedirectPayload,
  parseViptelFallbackSettings,
} from "./fallback-settings";
import {
  availableViptelOperatorCount,
  nextSafeFallbackAttempt,
  resolveRecentTimeoutHandoffIdentity,
  resolveWaitingFallbackProviderIdentity,
  viptelFallbackTrigger,
} from "./fallback-routing";

const revision = "11111111-1111-4111-8111-111111111111";
const actor = "22222222-2222-4222-8222-222222222222";

describe("VIPTel fallback settings", () => {
  it("reads a complete enabled setting", () => {
    expect(parseViptelFallbackSettings({
      inboundFallback: {
        schemaVersion: 1,
        enabled: true,
        destination: "0904123456",
        afterSeconds: 60,
        revision,
        updatedAt: "2026-08-31T12:00:00.000Z",
        updatedBy: actor,
      },
    })).toEqual({
      enabled: true,
      destination: "0904123456",
      afterSeconds: 60,
      revision,
      updatedAt: "2026-08-31T12:00:00.000Z",
      updatedBy: actor,
    });
  });

  it("fails closed when the durable authority fields are incomplete", () => {
    expect(parseViptelFallbackSettings({
      inboundFallback: {
        schemaVersion: 1,
        enabled: true,
        destination: "0904123456",
        afterSeconds: 60,
      },
    })).toMatchObject({ enabled: false, destination: null, revision: null, updatedBy: null });
  });

  it("recognizes only an exact phone redirect marker without an assignment guard", () => {
    const marker = { schemaVersion: 1, revision, destination: "0904123456", afterSeconds: 60 };
    expect(fallbackCommandMarker(marker)).toEqual({ ...marker, trigger: "timeout" });
    expect(isSystemFallbackRedirectPayload({
      destinationKind: "phone",
      destination: "0904123456",
      systemFallback: marker,
    })).toBe(true);
    expect(isSystemFallbackRedirectPayload({
      destinationKind: "phone",
      destination: "0904123456",
      systemFallback: marker,
      assignmentGuard: {},
    })).toBe(false);
  });

  it("counts registered unpaused operators once across the three dispatch queues", () => {
    expect(availableViptelOperatorCount({
      extensions: [
        extension("20", true),
        extension("21", true),
        extension("22", false),
      ],
      queueStatuses: [
        queue("601", [{ extension: "20", paused: false, inUse: true, dynamic: true, callsTaken: 0 }]),
        queue("602", [
          { extension: "20", paused: false, inUse: false, dynamic: true, callsTaken: 0 },
          { extension: "21", paused: true, inUse: false, dynamic: true, callsTaken: 0 },
        ]),
        queue("603", [{ extension: "22", paused: false, inUse: false, dynamic: true, callsTaken: 0 }]),
      ],
    })).toBe(1);
  });

  it("fails closed instead of claiming zero operators from an incomplete provider snapshot", () => {
    expect(() => availableViptelOperatorCount({
      extensions: [],
      queueStatuses: [queue("601", []), queue("602", [])],
    })).toThrow(/601–603/);
  });

  it("redirects immediately only for a verified empty operator set and otherwise waits for the timeout", () => {
    const now = new Date("2026-08-31T12:00:30.000Z");
    expect(viptelFallbackTrigger("2026-08-31T12:00:29.000Z", now, 60, true)).toBe("no_available_operators");
    expect(viptelFallbackTrigger("2026-08-31T12:00:29.000Z", now, 60, false)).toBeNull();
    expect(viptelFallbackTrigger("2026-08-31T11:59:30.000Z", now, 60, false)).toBe("timeout");
  });

  it("keeps the timeout anchored to the original call creation across queue handoffs", () => {
    const now = new Date("2026-08-31T12:01:00.000Z");
    const createdAt = "2026-08-31T12:00:00.000Z";
    const latestQueueJoinAt = "2026-08-31T12:00:48.000Z";

    expect(viptelFallbackTrigger(createdAt, now, 60, false)).toBe("timeout");
    expect(viptelFallbackTrigger(latestQueueJoinAt, now, 60, false)).toBeNull();
    expect(fallbackCallElapsedMs({ created_at: createdAt, started_at: latestQueueJoinAt }, now)).toBe(60_000);
  });

  it("resolves each simultaneous waiting caller to its own live queue parent", () => {
    const activeCalls = [
      activeCall("parent-a", "leg-a", "+421900000001"),
      activeCall("parent-b", "leg-b", "+421900000002"),
    ];

    expect(resolveWaitingFallbackProviderIdentity({
      from_queue_unique_id: "parent-a",
      viptel_unique_id: "leg-a",
    }, activeCalls)).toMatchObject({ uniqueId: "parent-a" });
    expect(resolveWaitingFallbackProviderIdentity({
      from_queue_unique_id: "parent-b",
      viptel_unique_id: "leg-b",
    }, activeCalls)).toMatchObject({ uniqueId: "parent-b" });
    expect(resolveWaitingFallbackProviderIdentity({
      from_queue_unique_id: "ended-parent",
      viptel_unique_id: "ended-leg",
    }, activeCalls)).toBeNull();
  });

  it("treats a provider-answered queue parent as waiting, but not an answered agent", () => {
    const queueParent = {
      direction: "inbound" as const,
      status: "answered" as const,
      viptelUniqueId: "parent-a",
      callerNumber: "+421900000001",
      raw: {},
    };
    expect(resolveWaitingFallbackProviderIdentity({
      from_queue_unique_id: "parent-a",
      viptel_unique_id: "leg-a",
    }, [queueParent])).toMatchObject({ uniqueId: "parent-a" });
    expect(resolveWaitingFallbackProviderIdentity({
      from_queue_unique_id: "parent-a",
      viptel_unique_id: "leg-a",
    }, [queueParent, {
      ...queueParent,
      fromQueueUniqueId: "parent-a",
      status: "answered",
      viptelUniqueId: "leg-a",
    }])).toBeNull();
  });

  it("uses a recent durable queue parent only during the short timeout handoff gap", () => {
    const call = {
      created_at: "2026-08-31T12:00:00.000Z",
      updated_at: "2026-08-31T12:00:58.000Z",
      from_queue_unique_id: "stable-parent",
      viptel_unique_id: "latest-agent-leg",
    };

    expect(resolveRecentTimeoutHandoffIdentity(
      call,
      new Date("2026-08-31T12:01:00.000Z"),
      60,
    )).toMatchObject({ uniqueId: "stable-parent" });
    expect(resolveRecentTimeoutHandoffIdentity(
      call,
      new Date("2026-08-31T12:01:31.000Z"),
      60,
    )).toBeNull();
  });

  it("retries only failures that certainly happened before VIPTel delivery", () => {
    const request_payload = {
      destinationKind: "phone",
      destination: "0904123456",
      systemFallback: { schemaVersion: 1, revision, destination: "0904123456", afterSeconds: 60 },
    };
    const failed = {
      call_id: "33333333-3333-4333-8333-333333333333",
      status: "failed" as const,
      request_payload,
      provider_response: { deliveryUncertain: false },
      updated_at: "2026-08-31T12:00:00.000Z",
    };

    expect(nextSafeFallbackAttempt([failed], revision, "timeout", new Date("2026-08-31T12:00:04.000Z"))).toBe(1);
    expect(nextSafeFallbackAttempt([
      { ...failed, provider_response: { deliveryUncertain: true } },
    ], revision, "timeout", new Date("2026-08-31T12:00:10.000Z"))).toBeNull();
    expect(nextSafeFallbackAttempt([
      { ...failed, status: "sent" },
    ], revision, "timeout", new Date("2026-08-31T12:00:10.000Z"))).toBeNull();
    expect(nextSafeFallbackAttempt([
      { ...failed, provider_response: { reason: "provider_rejected", code: 404 } },
    ], revision, "timeout", new Date("2026-08-31T12:00:10.000Z"))).toBeNull();
    expect(nextSafeFallbackAttempt([{
      ...failed,
      request_payload: {
        ...request_payload,
        systemFallback: { ...request_payload.systemFallback, trigger: "no_available_operators" },
      },
      provider_response: { reason: "provider_rejected", code: 404 },
    }], revision, "timeout", new Date("2026-08-31T12:00:10.000Z"))).toBe(0);
  });
});

function activeCall(parent: string, leg: string, callerNumber: string) {
  return {
    direction: "inbound" as const,
    status: "ringing_agent" as const,
    callerNumber,
    destinationExtension: "20",
    fromQueueUniqueId: parent,
    viptelUniqueId: leg,
    raw: {},
  };
}

function extension(extensionNumber: string, registered: boolean) {
  return {
    extension: extensionNumber,
    isRegistered: registered,
    allowedChanges: [],
    raw: {},
  };
}

function queue(
  queueNumber: string,
  members: Array<{ extension: string; paused: boolean; inUse: boolean; dynamic: boolean; callsTaken: number }>,
) {
  return { queue: queueNumber, members, waitingCalls: 0 };
}
