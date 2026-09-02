import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { MotoristActor } from "@/server/api-auth";
import type { Json } from "@/lib/supabase/database.types";
import {
  claimStaleAssignmentTransitionRecovery,
  claimStaleWorkplaceTransitionRecovery,
  readWorkplaceAssignmentTransition,
} from "./assignment-interlock";
import { compareAndSetDispatchRoutingState } from "./dispatch-routing";
import {
  assertExactWorkplaceProviderState,
  assertWorkplacePriorityDraftWriteUnlocked,
} from "./workplace-admin-actions";

const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  audit: "22222222-2222-4222-8222-222222222222",
  extension: "33333333-3333-4333-8333-333333333333",
  generation: "44444444-4444-4444-8444-444444444444",
  organization: "55555555-5555-4555-8555-555555555555",
  owner: "66666666-6666-4666-8666-666666666666",
  recovery: "77777777-7777-4777-8777-777777777777",
  transition: "88888888-8888-4888-8888-888888888888",
};
const actor: MotoristActor = {
  userId: "99999999-9999-4999-8999-999999999999",
  profileId: ids.actor,
  organizationId: ids.organization,
  displayName: "Admin",
  role: "admin",
};

describe("workplace admin safety invariants", () => {
  it("accepts only one disconnected, idle extension in its exact preserved queue", () => {
    expect(() => assertExactWorkplaceProviderState("20", "601", safeProvider())).not.toThrow();
    expect(() => assertExactWorkplaceProviderState("20", null, safeProvider())).toThrow("stále členom radu");
    expect(() => assertExactWorkplaceProviderState("20", "602", safeProvider())).toThrow("nezodpovedá presne");
  });

  it("accepts a planned workstation with no membership only when it is explicitly offline", () => {
    const offline = safeProvider({ offline: true });
    expect(() => assertExactWorkplaceProviderState("20", "601", offline)).toThrow("nezodpovedá presne");
    expect(() => assertExactWorkplaceProviderState("20", "601", offline, { allowOffline: true })).not.toThrow();
    expect(() => assertExactWorkplaceProviderState("20", null, offline, { allowOffline: true })).not.toThrow();
  });

  it("fails closed for registration, active calls, duplicate membership and in-use membership", () => {
    expect(() => assertExactWorkplaceProviderState("20", "601", safeProvider({ registered: true })))
      .toThrow("stále pripojený");
    expect(() => assertExactWorkplaceProviderState("20", "601", safeProvider({ activeCall: true })))
      .toThrow("prebieha alebo zvoní");
    expect(() => assertExactWorkplaceProviderState("20", "601", safeProvider({ duplicateMembership: true })))
      .toThrow("nezodpovedá presne");
    expect(() => assertExactWorkplaceProviderState("20", "601", safeProvider({ inUse: true })))
      .toThrow("označené ako používané");
    expect(() => assertExactWorkplaceProviderState("20", "601", safeProvider({ paused: true })))
      .toThrow("pozastavené");
  });

  it("can ignore only registrar presence while retaining every other live-state check", () => {
    expect(() => assertExactWorkplaceProviderState(
      "20",
      "601",
      safeProvider({ registered: true }),
      { allowRegistered: true },
    )).not.toThrow();
    expect(() => assertExactWorkplaceProviderState(
      "20",
      "601",
      safeProvider({ registered: true, activeCall: true }),
      { allowRegistered: true },
    )).toThrow("prebieha alebo zvoní");
    expect(() => assertExactWorkplaceProviderState(
      "20",
      "601",
      safeProvider({ registered: true, inUse: true }),
      { allowRegistered: true },
    )).toThrow("označené ako používané");
    const unknownRegistration = safeProvider();
    unknownRegistration.extensions[0].isRegistered = undefined as never;
    expect(() => assertExactWorkplaceProviderState(
      "20",
      "601",
      unknownRegistration,
      { allowRegistered: true },
    )).toThrow("jednoznačný stav registrácie");
  });

  it("blocks both self-service draft writes and routing root writes while owner handoff is active", async () => {
    const metadata = {
      dispatchRouting: { revision: 1, currentPlan: { "601": "20", "602": null, "603": null } },
      workplaceOwnerTransition: { active: true },
    };
    expect(() => assertWorkplacePriorityDraftWriteUnlocked(metadata)).toThrow("práve bezpečne mení");
    const client = { from: vi.fn() };
    await expect(compareAndSetDispatchRoutingState(client as never, {
      id: "queue-601",
      external_id: "601",
      line_id: null,
      metadata,
      updated_at: "root-v1",
    }, {
      revision: 1,
      currentPlan: { "601": "20", "602": null, "603": null },
    })).rejects.toMatchObject({ status: 409 });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("parses only canonical workplace recovery metadata with distinct identities", () => {
    expect(readWorkplaceAssignmentTransition(workplaceMetadata())).toMatchObject({
      auditId: ids.audit,
      initiatedBy: ids.actor,
      kind: "workplace_takeover",
      phase: "locked",
      previousLifecycle: { profileId: ids.owner, assignmentMode: "workplace_claim" },
    });
    expect(readWorkplaceAssignmentTransition(workplaceMetadata({ initiatedBy: undefined }))).toBeUndefined();
    expect(readWorkplaceAssignmentTransition(workplaceMetadata({ auditId: ids.generation }))).toBeUndefined();
    expect(readWorkplaceAssignmentTransition(workplaceMetadata({
      previousLifecycle: { ...previousLifecycle(), extension: "21" },
    }))).toMatchObject({ previousLifecycle: { extension: "21" } });
  });

  it("forbids legacy recovery and CAS-claims stale workplace recovery with a fresh identity", async () => {
    const row = extensionRow(workplaceMetadata());
    const legacyClient = { from: vi.fn() };
    await expect(claimStaleAssignmentTransitionRecovery(legacyClient as never, actor, row as never, {
      now: () => "2026-08-06T13:10:01.000Z",
      randomId: () => ids.recovery,
    })).rejects.toMatchObject({ code: "WORKPLACE_TRANSITION_RECOVERY_REQUIRED" });
    expect(legacyClient.from).not.toHaveBeenCalled();

    const recoveredMetadata = workplaceMetadata({
      recoveredBy: actor.profileId,
      recoveryOfTransitionId: ids.transition,
      startedAt: "2026-08-06T13:10:01.000Z",
      transitionId: ids.recovery,
    });
    const update = queryResult({ data: extensionRow(recoveredMetadata, "extension-v2"), error: null });
    const recovery = await claimStaleWorkplaceTransitionRecovery(
      sequentialClient([update]) as never,
      actor,
      row as never,
      { now: () => "2026-08-06T13:10:01.000Z", randomId: () => ids.recovery },
    );
    expect(recovery.workplaceTransition).toMatchObject({
      generation: ids.generation,
      initiatedBy: ids.actor,
      recoveredBy: actor.profileId,
      recoveryOfTransitionId: ids.transition,
      transitionId: ids.recovery,
    });
    expect(update.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v1"] });
    expect(update.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: {
        assignmentGeneration: ids.generation,
        assignmentTransition: {
          auditId: ids.audit,
          initiatedBy: ids.actor,
          recoveryOfTransitionId: ids.transition,
          transitionId: ids.recovery,
        },
      },
    });
  });
});

function previousLifecycle() {
  return {
    schemaVersion: 1 as const,
    epoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    state: "assigned" as const,
    extensionId: ids.extension,
    extension: "20",
    profileId: ids.owner,
    assignmentMode: "workplace_claim" as const,
    assignedAt: "2026-08-06T12:00:00.000Z",
    assignedBy: ids.owner,
  };
}

function workplaceMetadata(overrides: Record<string, unknown> = {}) {
  return {
    assignmentGeneration: ids.generation,
    assignmentLifecycle: previousLifecycle(),
    assignmentTransition: {
      active: true,
      auditId: ids.audit,
      fromProfileId: ids.owner,
      generation: ids.generation,
      initiatedBy: ids.actor,
      kind: "workplace_takeover",
      phase: "locked",
      preservedQueue: "601",
      previousLifecycle: previousLifecycle(),
      profileReservationPreviousExtension: null,
      startedAt: "2026-08-06T13:00:00.000Z",
      toProfileId: ids.actor,
      transitionId: ids.transition,
      ...overrides,
    },
  };
}

function extensionRow(metadata: Record<string, unknown>, updatedAt = "extension-v1") {
  return {
    active: true,
    extension: "20",
    id: ids.extension,
    metadata: metadata as Json,
    profile_id: ids.owner,
    updated_at: updatedAt,
  };
}

function safeProvider(options: {
  activeCall?: boolean;
  duplicateMembership?: boolean;
  inUse?: boolean;
  offline?: boolean;
  paused?: boolean;
  registered?: boolean;
} = {}) {
  return {
    extensions: [{
      extension: "20",
      isRegistered: options.registered ?? false,
      allowedChanges: [],
      raw: {},
    }],
    activeCalls: options.activeCall
      ? [{ direction: "inbound" as const, status: "ringing_agent" as const, destinationExtension: "20", raw: {} }]
      : [],
    queueStatuses: ["601", "602", "603"].map((queue) => ({
      queue,
      waitingCalls: 0,
      members: [
        ...(queue === "601" && !options.offline ? [{
          extension: "20",
          paused: options.paused ?? false,
          inUse: options.inUse ?? false,
          dynamic: true,
          callsTaken: 0,
        }] : []),
        ...(queue === "602" && options.duplicateMembership
          ? [{ extension: "20", paused: false, inUse: false, dynamic: true, callsTaken: 0 }]
          : []),
      ],
    })),
  };
}

function sequentialClient(results: Array<ReturnType<typeof queryResult>>) {
  let index = 0;
  return {
    from: vi.fn(() => {
      const result = results[index++];
      if (!result) throw new Error(`Unexpected query ${index - 1}.`);
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
