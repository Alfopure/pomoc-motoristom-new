import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { MotoristActor } from "@/server/api-auth";
import type { Json } from "@/lib/supabase/database.types";
import {
  AssignmentInterlockRejected,
  assertNoWorkplaceResourceClaimAfterAction,
  beginAssignmentTransition,
  captureRoutingAssignmentGuards,
  claimOwnedExtensionAction,
  releaseAssignmentTransition,
  releaseExtensionAssignmentGuard,
  reconcileTerminalExtensionAssignmentClaim,
  releaseRoutingAssignmentGuards,
  revalidateCallCommandAssignment,
  revalidateExtensionAssignmentGuard,
} from "./assignment-interlock";

const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  extension: "22222222-2222-4222-8222-222222222222",
  extension2: "99999999-9999-4999-8999-999999999999",
  generation: "33333333-3333-4333-8333-333333333333",
  lifecycle: "88888888-8888-4888-8888-888888888888",
  claim: "44444444-4444-4444-8444-444444444444",
  transition: "55555555-5555-4555-8555-555555555555",
  organization: "66666666-6666-4666-8666-666666666666",
  routingOperation: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
const now = "2026-08-04T17:00:00.000Z";
const actor: MotoristActor = {
  userId: "77777777-7777-4777-8777-777777777777",
  profileId: ids.actor,
  organizationId: ids.organization,
  displayName: "Operátor",
  role: "dispatcher",
};

beforeEach(() => {
  process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
  process.env.VIPTEL_LIVE_MUTATION_TOKEN = "test-authority-token-at-least-32-characters";
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  delete process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
  delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
  delete process.env.VERCEL_ENV;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED;
});

describe("personal-extension assignment interlock", () => {
  it("revalidates the source assignment but needs no operator lifecycle for an external redirect", async () => {
    const row = extensionRow({ metadata: actionMetadata("call.redirect") });
    const client = sequentialClient([
      queryResult({ data: row, error: null }),
      ...immutableLifecycleQueries(row),
    ]);

    await expect(revalidateCallCommandAssignment(client as never, ids.organization, {
      command_type: "call.redirect",
      extension_id: ids.extension,
      requested_by: ids.actor,
      request_payload: {
        assignmentGuard: assignmentGuard(),
        destinationKind: "phone",
        destination: "0900111222",
      },
    })).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it("rejects an external redirect carrying forged operator target fields", async () => {
    const row = extensionRow({ metadata: actionMetadata("call.redirect") });
    const client = sequentialClient([
      queryResult({ data: row, error: null }),
      ...immutableLifecycleQueries(row),
    ]);

    await expect(revalidateCallCommandAssignment(client as never, ids.organization, {
      command_type: "call.redirect",
      extension_id: ids.extension,
      requested_by: ids.actor,
      request_payload: {
        assignmentGuard: assignmentGuard(),
        destinationKind: "phone",
        destination: "0900111222",
        destinationProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    })).rejects.toBeInstanceOf(AssignmentInterlockRejected);
  });

  it("does not read or write the interlock while the central mutation gate is disabled", async () => {
    process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "false";
    const client = { from: vi.fn() };

    await expect(claimOwnedExtensionAction(actor, ids.extension, "call.create", {
      client: client as never,
    })).rejects.toMatchObject({ status: 503 });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("claims an operator action with an updated_at/profile CAS and a persisted generation", async () => {
    const row = extensionRow();
    const current = queryResult({ data: row, error: null });
    const claimed = queryResult({
      data: extensionRow({
        metadata: actionMetadata("call.create"),
        updated_at: "extension-v2",
      }),
      error: null,
    });
    const lifecycle = immutableLifecycleQueries(row);
    const client = sequentialClient([current, ...lifecycle, claimed]);
    const randomIds = [ids.generation, ids.claim];

    const result = await claimOwnedExtensionAction(actor, ids.extension, "call.create", {
      client: client as never,
      now: () => now,
      randomId: () => randomIds.shift() as string,
    });

    expect(result.assignmentGuard).toEqual({
      claimId: ids.claim,
      extension: "20",
      extensionId: ids.extension,
      generation: ids.generation,
      lifecycleEpoch: ids.lifecycle,
      profileId: ids.actor,
    });
    expect(claimed.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v1"] });
    expect(claimed.calls).toContainEqual({ method: "eq", args: ["profile_id", ids.actor] });
    expect(claimed.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: actionMetadata("call.create"),
    });
    expect(lifecycle[0].calls).toContainEqual({ method: "eq", args: ["entity_id", ids.extension] });
    expect(lifecycle[1].calls).toContainEqual({ method: "eq", args: ["id", ids.actor] });
  });

  it("lets an assignment transition and an action race on one CAS instead of both succeeding", async () => {
    const transitionLost = queryResult({ data: null, error: null });
    const transitionClient = sequentialClient([transitionLost]);
    const randomIds = [ids.transition, ids.generation];
    await expect(beginAssignmentTransition(
      transitionClient as never,
      actor,
      extensionRow(),
      null,
      { now: () => now, randomId: () => randomIds.shift() as string },
    )).rejects.toMatchObject({ status: 409 });
    expect(transitionLost.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v1"] });

    const row = extensionRow();
    const current = queryResult({ data: row, error: null });
    const actionLost = queryResult({ data: null, error: null });
    const ownerChanged = queryResult({
      data: extensionRow({
        metadata: {
          assignmentGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          assignmentTransition: { active: true },
        },
        updated_at: "extension-v2",
      }),
      error: null,
    });
    const actionClient = sequentialClient([current, ...immutableLifecycleQueries(row), actionLost, ownerChanged]);
    await expect(claimOwnedExtensionAction(actor, ids.extension, "call.hangup", {
      client: actionClient as never,
      now: () => now,
      randomId: vi.fn()
        .mockReturnValueOnce(ids.generation)
        .mockReturnValueOnce(ids.claim),
    })).rejects.toMatchObject({ status: 409 });
    expect(actionLost.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v1"] });
  });

  it("retries one provider-only updated_at collision after revalidating lifecycle and ownership", async () => {
    const metadata = { assignmentGeneration: ids.generation };
    const original = extensionRow({ metadata, updated_at: "extension-v1" });
    const providerRefreshed = extensionRow({ metadata, updated_at: "extension-v2" });
    const firstClaimLost = queryResult({ data: null, error: null });
    const claimed = queryResult({
      data: extensionRow({
        metadata: actionMetadata("webphone.session.issue"),
        updated_at: "extension-v3",
      }),
      error: null,
    });
    const client = sequentialClient([
      queryResult({ data: original, error: null }),
      ...immutableLifecycleQueries(original),
      firstClaimLost,
      queryResult({ data: providerRefreshed, error: null }),
      ...immutableLifecycleQueries(providerRefreshed),
      claimed,
    ]);

    const result = await claimOwnedExtensionAction(actor, ids.extension, "webphone.session.issue", {
      client: client as never,
      now: () => now,
      randomId: vi.fn()
        .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab")
        .mockReturnValueOnce(ids.claim),
    });

    expect(result.assignmentGuard).toMatchObject({
      claimId: ids.claim,
      generation: ids.generation,
      profileId: ids.actor,
    });
    expect(firstClaimLost.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v1"] });
    expect(claimed.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v2"] });
    expect(client.from).toHaveBeenCalledTimes(8);
  });

  it.each([
    {
      label: "assignment metadata",
      refreshed: extensionRow({
        metadata: { assignmentGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        updated_at: "extension-v2",
      }),
    },
    {
      label: "owner",
      // The ownership-filtered retry read returns no row after another
      // operator wins the assignment race.
      refreshed: null,
    },
    {
      label: "unchanged updated_at",
      refreshed: extensionRow({ updated_at: "extension-v1" }),
    },
  ])("does not retry a CAS collision after $label changes", async ({ refreshed }) => {
    const original = extensionRow();
    const firstClaimLost = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({ data: original, error: null }),
      ...immutableLifecycleQueries(original),
      firstClaimLost,
      queryResult({ data: refreshed, error: null }),
    ]);

    await expect(claimOwnedExtensionAction(actor, ids.extension, "webphone.session.issue", {
      client: client as never,
      now: () => now,
      randomId: vi.fn()
        .mockReturnValueOnce(ids.generation)
        .mockReturnValueOnce(ids.claim),
    })).rejects.toMatchObject({ status: 409 });
    expect(client.from).toHaveBeenCalledTimes(5);
  });

  it("blocks assignment when a browser session was issued just before the assignment loaded the row", async () => {
    const client = { from: vi.fn() };
    const metadata = actionMetadata("webphone.session.issue", "2026-08-04T16:59:59.000Z");

    await expect(beginAssignmentTransition(
      client as never,
      actor,
      extensionRow({ metadata }),
      null,
      { now: () => now, randomId: () => ids.transition },
    )).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("práve autorizovaná"),
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("does not let a crashed process release a newer active recovery transition", async () => {
    const originalMetadata = {
      assignmentGeneration: ids.generation,
      assignmentTransition: {
        active: true,
        fromProfileId: ids.actor,
        generation: ids.generation,
        initiatedBy: ids.actor,
        startedAt: "2026-08-04T16:00:00.000Z",
        toProfileId: null,
        transitionId: ids.transition,
      },
    };
    const recoveryGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const recoveryTransition = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const staleRelease = queryResult({ data: null, error: null });
    const currentRecovery = queryResult({
      data: extensionRow({
        metadata: {
          assignmentGeneration: recoveryGeneration,
          assignmentTransition: {
            active: true,
            fromProfileId: ids.actor,
            generation: recoveryGeneration,
            initiatedBy: ids.actor,
            startedAt: now,
            toProfileId: null,
            transitionId: recoveryTransition,
          },
        },
        updated_at: "extension-v2",
      }),
      error: null,
    });
    const client = sequentialClient([staleRelease, currentRecovery]);

    await expect(releaseAssignmentTransition(client as never, actor, {
      extension: extensionRow({ metadata: originalMetadata }),
      generation: ids.generation,
      transitionId: ids.transition,
    })).resolves.toBe(false);
    expect(client.from).toHaveBeenCalledTimes(2);
  });

  it("keeps a routing claim exclusive beyond the short browser grace until exact release", async () => {
    const routingMetadata = actionMetadata("dispatch.routing.apply", "2026-08-04T16:00:00.000Z");
    const actionRow = extensionRow({ metadata: routingMetadata });
    const actionClient = sequentialClient([
      queryResult({ data: actionRow, error: null }),
      ...immutableLifecycleQueries(actionRow),
    ]);
    await expect(claimOwnedExtensionAction(actor, ids.extension, "call.create", {
      client: actionClient as never,
      now: () => now,
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("poradia radov") });
    expect(actionClient.from).toHaveBeenCalledTimes(3);

    const routingRow = extensionRow({ metadata: routingMetadata });
    const current = queryResult({ data: routingRow, error: null });
    const released = queryResult({ data: { id: ids.extension }, error: null });
    await expect(releaseRoutingAssignmentGuards(
      sequentialClient([current, released]) as never,
      ids.organization,
      [{
        claimId: ids.claim,
        extension: "20",
        extensionId: ids.extension,
        generation: ids.generation,
        lifecycleEpoch: ids.lifecycle,
        profileId: ids.actor,
      }],
    )).resolves.toBeUndefined();
    expect(released.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: { assignmentGeneration: ids.generation },
    });
  });

  it("takes over a routing claim orphaned by a crash before the queue-601 root CAS after its lease", async () => {
    const orphan = actionMetadata(
      "dispatch.routing.apply",
      "2026-08-04T16:57:00.000Z",
      ids.routingOperation,
    );
    const orphanRow = extensionRow({ metadata: orphan });
    const current = queryResult({ data: orphanRow, error: null });
    const rootWithoutOperation = queryResult({
      data: { metadata: { dispatchRouting: { revision: 1, currentPlan: { "601": "20", "602": "21", "603": "22" } } } },
      error: null,
    });
    const replacementClaim = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const claimed = queryResult({
      data: extensionRow({
        updated_at: "extension-v2",
        metadata: {
          assignmentGeneration: ids.generation,
          assignmentActionClaim: {
            action: "call.create",
            claimId: replacementClaim,
            claimedAt: now,
            generation: ids.generation,
            lifecycleEpoch: ids.lifecycle,
            profileId: ids.actor,
          },
        },
      }),
      error: null,
    });

    await expect(claimOwnedExtensionAction(actor, ids.extension, "call.create", {
      client: sequentialClient([current, ...immutableLifecycleQueries(orphanRow), rootWithoutOperation, claimed]) as never,
      now: () => now,
      randomId: () => replacementClaim,
    })).resolves.toMatchObject({ assignmentGuard: { claimId: replacementClaim } });
  });

  it("never expires a routing claim backed by the exact durable queue-601 operation", async () => {
    const routingMetadata = actionMetadata(
      "dispatch.routing.apply",
      "2026-08-04T16:00:00.000Z",
      ids.routingOperation,
    );
    const durableRoutingRow = extensionRow({ metadata: routingMetadata });
    const current = queryResult({ data: durableRoutingRow, error: null });
    const rootWithOperation = queryResult({
      data: {
        metadata: {
          dispatchRouting: {
            revision: 1,
            currentPlan: { "601": "20", "602": "21", "603": "22" },
            operation: {
              operationId: ids.routingOperation,
              assignmentGuards: [{
                claimId: ids.claim,
                extension: "20",
                extensionId: ids.extension,
                generation: ids.generation,
                lifecycleEpoch: ids.lifecycle,
                profileId: ids.actor,
                routingOperationId: ids.routingOperation,
              }],
            },
          },
        },
      },
      error: null,
    });
    const client = sequentialClient([current, ...immutableLifecycleQueries(durableRoutingRow), rootWithOperation]);

    await expect(claimOwnedExtensionAction(actor, ids.extension, "call.create", {
      client: client as never,
      now: () => now,
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("poradia radov") });
    expect(client.from).toHaveBeenCalledTimes(4);
  });

  it("borrows but never replaces the exact own self-service routing guard for webphone registration", async () => {
    const routingGuard = { ...assignmentGuard(), routingOperationId: ids.routingOperation };
    const durableRoutingRow = extensionRow({
      metadata: actionMetadata("dispatch.routing.apply", "2026-08-04T16:00:00.000Z", ids.routingOperation),
    });
    const root = queryResult({ data: selfServiceRoutingRoot(routingGuard), error: null });
    const revalidated = queryResult({ data: durableRoutingRow, error: null });
    const lifecycleBefore = immutableLifecycleQueries(durableRoutingRow);
    const lifecycleAfter = immutableLifecycleQueries(durableRoutingRow);
    const results = [
      queryResult({ data: durableRoutingRow, error: null }),
      ...lifecycleBefore,
      root,
      revalidated,
      ...lifecycleAfter,
    ];
    const client = sequentialClient(results);

    const borrowed = await claimOwnedExtensionAction(actor, ids.extension, "webphone.session.issue", {
      allowExactRoutingWebphoneSession: true,
      client: client as never,
      leaseFence: webphoneLeaseFence(),
      now: () => now,
      randomId: () => {
        throw new Error("A borrowed routing guard must not create an action claim.");
      },
    });

    expect(borrowed).toMatchObject({
      assignmentGuard: routingGuard,
      releaseAssignmentGuard: false,
    });
    expect(root.calls).toContainEqual({ method: "eq", args: ["external_id", "601"] });
    expect(results.flatMap((result) => result.calls).some((call) => call.method === "update")).toBe(false);
  });

  it.each([
    { label: "foreign actor", rootOverride: { actorProfileId: ids.extension2 } },
    { label: "another operation", rootOverride: { operationId: ids.extension2 } },
    { label: "another assignment guard", rootOverride: { assignmentGuards: [] } },
    { label: "manager routing", rootOverride: { rootMetadataGuard: undefined } },
    {
      label: "malformed self-service authority",
      rootOverride: {
        rootMetadataGuard: { key: "workplacePriorityDraft", digest: "invalid", authorityId: ids.transition },
      },
    },
    {
      label: "unrelated extension",
      rootOverride: {
        previousPlan: { "601": "21", "602": null, "603": null },
        targetPlan: { "601": "21", "602": null, "603": null },
      },
    },
  ])("does not borrow the routing guard for $label", async ({ rootOverride }) => {
    const routingGuard = { ...assignmentGuard(), routingOperationId: ids.routingOperation };
    const durableRoutingRow = extensionRow({
      metadata: actionMetadata("dispatch.routing.apply", "2026-08-04T16:00:00.000Z", ids.routingOperation),
    });
    const root = selfServiceRoutingRoot(routingGuard);
    const operation = {
      ...(root.metadata as Record<string, Record<string, unknown>>).dispatchRouting.operation as Record<string, unknown>,
      ...rootOverride,
    };
    (root.metadata as Record<string, Record<string, unknown>>).dispatchRouting.operation = operation;
    const client = sequentialClient([
      queryResult({ data: durableRoutingRow, error: null }),
      ...immutableLifecycleQueries(durableRoutingRow),
      queryResult({ data: root, error: null }),
    ]);

    await expect(claimOwnedExtensionAction(actor, ids.extension, "webphone.session.issue", {
      allowExactRoutingWebphoneSession: true,
      client: client as never,
      leaseFence: webphoneLeaseFence(),
      now: () => now,
    })).rejects.toMatchObject({ code: "routing_webphone_guard_mismatch", status: 409 });
  });

  it("does not borrow an exact routing guard without an explicit browser lease fence", async () => {
    const routingGuard = { ...assignmentGuard(), routingOperationId: ids.routingOperation };
    const durableRoutingRow = extensionRow({
      metadata: actionMetadata("dispatch.routing.apply", "2026-08-04T16:00:00.000Z", ids.routingOperation),
    });
    const client = sequentialClient([
      queryResult({ data: durableRoutingRow, error: null }),
      ...immutableLifecycleQueries(durableRoutingRow),
      queryResult({ data: selfServiceRoutingRoot(routingGuard), error: null }),
    ]);

    await expect(claimOwnedExtensionAction(actor, ids.extension, "webphone.session.issue", {
      allowExactRoutingWebphoneSession: true,
      client: client as never,
      now: () => now,
    })).rejects.toMatchObject({ code: "routing_webphone_guard_mismatch", status: 409 });
  });

  it("does not turn an old orphan routing claim into a webphone issuance claim", async () => {
    const orphanRow = extensionRow({
      metadata: actionMetadata("dispatch.routing.apply", "2026-08-04T16:00:00.000Z", ids.routingOperation),
    });
    const client = sequentialClient([
      queryResult({ data: orphanRow, error: null }),
      ...immutableLifecycleQueries(orphanRow),
      queryResult({ data: { metadata: { dispatchRouting: { revision: 2 } } }, error: null }),
    ]);

    await expect(claimOwnedExtensionAction(actor, ids.extension, "webphone.session.issue", {
      allowExactRoutingWebphoneSession: true,
      client: client as never,
      leaseFence: webphoneLeaseFence(),
      now: () => now,
    })).rejects.toMatchObject({ code: "routing_webphone_guard_mismatch", status: 409 });
  });

  it("fails closed when the exact borrowed routing guard cannot be revalidated", async () => {
    const routingGuard = { ...assignmentGuard(), routingOperationId: ids.routingOperation };
    const durableRoutingRow = extensionRow({
      metadata: actionMetadata("dispatch.routing.apply", "2026-08-04T16:00:00.000Z", ids.routingOperation),
    });
    const client = sequentialClient([
      queryResult({ data: durableRoutingRow, error: null }),
      ...immutableLifecycleQueries(durableRoutingRow),
      queryResult({ data: selfServiceRoutingRoot(routingGuard), error: null }),
      queryResult({ data: null, error: null }),
    ]);

    await expect(claimOwnedExtensionAction(actor, ids.extension, "webphone.session.issue", {
      allowExactRoutingWebphoneSession: true,
      client: client as never,
      leaseFence: webphoneLeaseFence(),
      now: () => now,
    })).rejects.toMatchObject({ code: "routing_webphone_guard_changed", status: 409 });
  });

  it("resumes an exact routing release when an earlier guard was already cleared", async () => {
    const secondGuard = {
      claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      extension: "21",
      extensionId: ids.extension2,
      generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      lifecycleEpoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const alreadyReleased = queryResult({
      data: extensionRow({ metadata: { assignmentGeneration: ids.generation } }),
      error: null,
    });
    const stillClaimed = queryResult({
      data: extensionRow({
        id: secondGuard.extensionId,
        extension: secondGuard.extension,
        profile_id: secondGuard.profileId,
        metadata: {
          assignmentGeneration: secondGuard.generation,
          assignmentActionClaim: {
            action: "dispatch.routing.apply",
            claimId: secondGuard.claimId,
            claimedAt: now,
            generation: secondGuard.generation,
            lifecycleEpoch: secondGuard.lifecycleEpoch,
            profileId: secondGuard.profileId,
          },
        },
      }),
      error: null,
    });
    const released = queryResult({ data: { id: secondGuard.extensionId }, error: null });

    await expect(releaseRoutingAssignmentGuards(
      sequentialClient([alreadyReleased, stillClaimed, released]) as never,
      ids.organization,
      [{
        claimId: ids.claim,
        extension: "20",
        extensionId: ids.extension,
        generation: ids.generation,
        lifecycleEpoch: ids.lifecycle,
        profileId: ids.actor,
      }, secondGuard],
    )).resolves.toBeUndefined();
    expect(released.calls).toContainEqual({ method: "eq", args: ["id", secondGuard.extensionId] });
  });

  it("captures a routing guard through CAS and revalidates the exact current claim", async () => {
    const row = extensionRow();
    const list = queryResult({ data: [row], error: null });
    const claim = queryResult({ data: { id: ids.extension }, error: null });
    const client = sequentialClient([list, ...immutableLifecycleQueries(row), claim]);
    const randomIds = [ids.generation, ids.claim];
    const guards = await captureRoutingAssignmentGuards(
      client as never,
      ids.organization,
      [ids.extension],
      "dispatch.routing.apply",
      ids.routingOperation,
      { now: () => now, randomId: () => randomIds.shift() as string },
    );
    expect(guards).toEqual([{
      claimId: ids.claim,
      extension: "20",
      extensionId: ids.extension,
      generation: ids.generation,
      lifecycleEpoch: ids.lifecycle,
      profileId: ids.actor,
      routingOperationId: ids.routingOperation,
    }]);
    expect(claim.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v1"] });

    const validRow = extensionRow({ metadata: actionMetadata("dispatch.routing.apply", now, ids.routingOperation) });
    const valid = queryResult({ data: validRow, error: null });
    await expect(revalidateExtensionAssignmentGuard(
      sequentialClient([valid, ...immutableLifecycleQueries(validRow)]) as never,
      ids.organization,
      guards[0],
    )).resolves.toBeUndefined();
  });

  it("retries an exact guard release after provider-only updated_at drift", async () => {
    const metadata = actionMetadata("webphone.session.issue");
    const firstRead = queryResult({
      data: extensionRow({ metadata, updated_at: "extension-v1" }),
      error: null,
    });
    const firstWriteLost = queryResult({ data: null, error: null });
    const providerRefreshed = queryResult({
      data: extensionRow({ metadata, updated_at: "extension-v2" }),
      error: null,
    });
    const released = queryResult({ data: { id: ids.extension }, error: null });
    const client = sequentialClient([firstRead, firstWriteLost, providerRefreshed, released]);

    await expect(releaseExtensionAssignmentGuard(
      client as never,
      ids.organization,
      assignmentGuard(),
    )).resolves.toBeUndefined();

    expect(firstWriteLost.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v1"] });
    expect(released.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v2"] });
    expect(released.calls).toContainEqual({ method: "eq", args: ["active", true] });
    expect(firstRead.calls).toContainEqual({
      method: "select",
      args: ["id, extension, profile_id, active, metadata, updated_at"],
    });
    expect(client.from).toHaveBeenCalledTimes(4);
  });

  it("reads the hot-desk schema marker only for a release guard that binds it", async () => {
    const workplaceSeatGeneration = "abababab-abab-4bab-8bab-abababababab";
    const guard = { ...assignmentGuard(), workplaceSeatGeneration };
    const current = queryResult({
      data: extensionRow({
        metadata: actionMetadata("webphone.session.issue"),
        workplace_seat_generation: workplaceSeatGeneration,
      }),
      error: null,
    });
    const released = queryResult({ data: { id: ids.extension }, error: null });

    await expect(releaseExtensionAssignmentGuard(
      sequentialClient([current, released]) as never,
      ids.organization,
      guard,
    )).resolves.toBeUndefined();

    expect(current.calls).toContainEqual({
      method: "select",
      args: ["id, extension, profile_id, active, metadata, updated_at, workplace_seat_generation"],
    });
  });

  it.each([
    {
      label: "a newer claim",
      refreshed: extensionRow({
        metadata: {
          assignmentGeneration: ids.generation,
          assignmentActionClaim: {
            ...actionMetadata("webphone.session.issue").assignmentActionClaim,
            claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
        },
        updated_at: "extension-v2",
      }),
    },
    {
      label: "a new owner",
      refreshed: extensionRow({
        metadata: actionMetadata("webphone.session.issue"),
        profile_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        updated_at: "extension-v2",
      }),
    },
  ])("never clears the old guard after $label wins the release race", async ({ refreshed }) => {
    const firstRead = queryResult({
      data: extensionRow({ metadata: actionMetadata("webphone.session.issue"), updated_at: "extension-v1" }),
      error: null,
    });
    const firstWriteLost = queryResult({ data: null, error: null });
    const client = sequentialClient([
      firstRead,
      firstWriteLost,
      queryResult({ data: refreshed, error: null }),
    ]);

    await expect(releaseExtensionAssignmentGuard(
      client as never,
      ids.organization,
      assignmentGuard(),
    )).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it("fails closed when semantic assignment metadata changes around an exact guard", async () => {
    const initialMetadata = actionMetadata("webphone.session.issue");
    const changedMetadata = { ...initialMetadata, unexpectedAssignmentState: "changed" };
    const client = sequentialClient([
      queryResult({
        data: extensionRow({ metadata: initialMetadata, updated_at: "extension-v1" }),
        error: null,
      }),
      queryResult({ data: null, error: null }),
      queryResult({
        data: extensionRow({ metadata: changedMetadata, updated_at: "extension-v2" }),
        error: null,
      }),
    ]);

    await expect(releaseExtensionAssignmentGuard(
      client as never,
      ids.organization,
      assignmentGuard(),
    )).rejects.toBeInstanceOf(AssignmentInterlockRejected);
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it("stops after one exact release retry when provider writes keep winning", async () => {
    const metadata = actionMetadata("webphone.session.issue");
    const firstWriteLost = queryResult({ data: null, error: null });
    const retryWriteLost = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({ data: extensionRow({ metadata, updated_at: "extension-v1" }), error: null }),
      firstWriteLost,
      queryResult({ data: extensionRow({ metadata, updated_at: "extension-v2" }), error: null }),
      retryWriteLost,
      queryResult({ data: extensionRow({ metadata, updated_at: "extension-v3" }), error: null }),
    ]);

    await expect(releaseExtensionAssignmentGuard(
      client as never,
      ids.organization,
      assignmentGuard(),
    )).rejects.toBeInstanceOf(AssignmentInterlockRejected);
    expect(firstWriteLost.calls.filter((call) => call.method === "update")).toHaveLength(1);
    expect(retryWriteLost.calls.filter((call) => call.method === "update")).toHaveLength(1);
    expect(client.from).toHaveBeenCalledTimes(5);
  });

  it("keeps a historical pre-migration workplace_claim seat on the legacy action and routing path", async () => {
    const lifecycle = {
      ...assignmentLifecycleFor(extensionRow()),
      assignmentMode: "workplace_claim",
    };
    const row = extensionRow({ metadata: { assignmentLifecycle: lifecycle } });
    const missingMarker = () => queryResult({
      data: null,
      error: {
        code: "PGRST204",
        message: "Could not find the 'workplace_seat_generation' column in the schema cache",
      },
    });
    const claimed = queryResult({
      data: extensionRow({
        metadata: {
          assignmentGeneration: ids.generation,
          assignmentLifecycle: lifecycle,
          assignmentActionClaim: {
            action: "call.create",
            claimId: ids.claim,
            claimedAt: now,
            generation: ids.generation,
            lifecycleEpoch: ids.lifecycle,
            profileId: ids.actor,
          },
        },
      }),
      error: null,
    });
    const actionClient = sequentialClient([
      queryResult({ data: row, error: null }),
      ...immutableLifecycleQueries(row, lifecycle),
      missingMarker(),
      claimed,
    ]);

    await expect(claimOwnedExtensionAction(actor, ids.extension, "call.create", {
      client: actionClient as never,
      now: () => now,
      randomId: vi.fn().mockReturnValueOnce(ids.generation).mockReturnValueOnce(ids.claim),
    })).resolves.toMatchObject({ assignmentGuard: { claimId: ids.claim } });
    expect(actionClient.from).toHaveBeenCalledTimes(5);

    const routingClaim = queryResult({ data: { id: ids.extension }, error: null });
    const routingClient = sequentialClient([
      queryResult({ data: [row], error: null }),
      ...immutableLifecycleQueries(row, lifecycle),
      missingMarker(),
      routingClaim,
    ]);
    await expect(captureRoutingAssignmentGuards(
      routingClient as never,
      ids.organization,
      [ids.extension],
      "dispatch.routing.apply",
      ids.routingOperation,
      { now: () => now, randomId: vi.fn().mockReturnValueOnce(ids.generation).mockReturnValueOnce(ids.claim) },
    )).resolves.toEqual([expect.not.objectContaining({ workplaceSeatGeneration: expect.anything() })]);
    expect(routingClient.from).toHaveBeenCalledTimes(5);
  });

  it("captures and revalidates an audited free hot-desk seat retained by the routing plan", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    const seatGeneration = "abababab-abab-4bab-8bab-abababababab";
    const lifecycle = {
      schemaVersion: 1,
      epoch: ids.lifecycle,
      state: "unassigned",
      extensionId: ids.extension,
      extension: "20",
      profileId: null,
      assignmentMode: "workplace_claim",
      assignedAt: "2026-08-04T16:00:00.000Z",
      assignedBy: ids.actor,
      unassignedAt: "2026-08-04T16:30:00.000Z",
      unassignedBy: ids.actor,
    };
    const row = extensionRow({
      profile_id: null,
      workplace_seat_generation: seatGeneration,
      metadata: { assignmentGeneration: ids.generation, assignmentLifecycle: lifecycle },
    });
    const client = sequentialClient([
      queryResult({ data: [row], error: null }),
      queryResult({
        data: {
          id: "free-seat-audit",
          action: "telephony.extension.unassign",
          after_payload: { assignment_lifecycle: lifecycle },
          created_at: "2026-08-04T16:30:00.000Z",
        },
        error: null,
      }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [{ id: ids.extension, workplace_seat_generation: seatGeneration }], error: null }),
      queryResult({ data: { id: ids.extension }, error: null }),
      queryResult({ data: { operation_id: null, claim_generation: null }, error: null }),
    ]);

    const [guard] = await captureRoutingAssignmentGuards(
      client as never,
      ids.organization,
      [ids.extension],
      "dispatch.routing.apply",
      ids.routingOperation,
      { now: () => now, randomId: () => ids.claim },
    );

    expect(guard).toMatchObject({
      extension: "20",
      profileId: null,
      workplaceSeatGeneration: seatGeneration,
      routingOperationId: ids.routingOperation,
    });

    const claimedRow = extensionRow({
      profile_id: null,
      workplace_seat_generation: seatGeneration,
      metadata: {
        assignmentGeneration: ids.generation,
        assignmentLifecycle: lifecycle,
        assignmentActionClaim: {
          action: "dispatch.routing.apply",
          claimId: ids.claim,
          claimedAt: now,
          generation: ids.generation,
          lifecycleEpoch: ids.lifecycle,
          profileId: null,
          routingOperationId: ids.routingOperation,
        },
      },
    });
    await expect(revalidateExtensionAssignmentGuard(
      sequentialClient([
        queryResult({ data: claimedRow, error: null }),
        queryResult({
          data: {
            id: "free-seat-audit",
            action: "telephony.extension.unassign",
            after_payload: { assignment_lifecycle: lifecycle },
            created_at: "2026-08-04T16:30:00.000Z",
          },
          error: null,
        }),
        queryResult({ data: [], error: null }),
      ]) as never,
      ids.organization,
      guard,
    )).resolves.toBeUndefined();
  });

  it("backs routing out when a workplace operation wins the shared resource before the post-check", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    const seatGeneration = "abababab-abab-4bab-8bab-abababababab";
    const lifecycle = {
      ...assignmentLifecycleFor(extensionRow()),
      assignmentMode: "workplace_claim",
    };
    const row = extensionRow({
      workplace_seat_generation: seatGeneration,
      metadata: { assignmentGeneration: ids.generation, assignmentLifecycle: lifecycle },
    });
    const claimedRow = extensionRow({
      workplace_seat_generation: seatGeneration,
      metadata: {
        assignmentGeneration: ids.generation,
        assignmentLifecycle: lifecycle,
        assignmentActionClaim: {
          action: "dispatch.routing.apply",
          claimId: ids.claim,
          claimedAt: now,
          generation: ids.generation,
          lifecycleEpoch: ids.lifecycle,
          profileId: ids.actor,
          routingOperationId: ids.routingOperation,
        },
      },
    });
    const releasedRow = extensionRow({
      workplace_seat_generation: seatGeneration,
      metadata: { assignmentGeneration: ids.generation, assignmentLifecycle: lifecycle },
    });
    const cleanupWrite = queryResult({ data: { id: ids.extension }, error: null });
    const client = sequentialClient([
      queryResult({ data: [row], error: null }),
      ...immutableLifecycleQueries(row, lifecycle),
      queryResult({ data: [{ id: ids.extension, workplace_seat_generation: seatGeneration }], error: null }),
      queryResult({ data: { id: ids.extension }, error: null }),
      queryResult({ data: { operation_id: ids.routingOperation, claim_generation: ids.claim }, error: null }),
      queryResult({ data: claimedRow, error: null }),
      cleanupWrite,
      queryResult({ data: releasedRow, error: null }),
    ]);

    await expect(captureRoutingAssignmentGuards(
      client as never,
      ids.organization,
      [ids.extension],
      "dispatch.routing.apply",
      ids.routingOperation,
      { now: () => now, randomId: () => ids.claim },
    )).rejects.toMatchObject({ code: "lease_transitioning", status: 409 });

    expect(cleanupWrite.calls.find((call) => call.method === "update")?.args[0])
      .toMatchObject({ metadata: { assignmentGeneration: ids.generation } });
  });

  it("releases already captured routing claims when a later extension loses the CAS race", async () => {
    const secondProfile = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondGeneration = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const secondClaim = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const firstRow = extensionRow();
    const secondRow = extensionRow({ id: ids.extension2, extension: "21", profile_id: secondProfile });
    const rows = queryResult({ data: [firstRow, secondRow], error: null });
    const firstClaim = queryResult({ data: { id: ids.extension }, error: null });
    const secondClaimRace = queryResult({ data: null, error: null });
    const cleanupRead = queryResult({
      data: extensionRow({ metadata: actionMetadata("dispatch.routing.apply", now, ids.routingOperation) }),
      error: null,
    });
    const cleanupWrite = queryResult({ data: { id: ids.extension }, error: null });
    const client = sequentialClient([
      rows,
      ...immutableLifecycleQueries(firstRow),
      ...immutableLifecycleQueries(secondRow),
      firstClaim,
      secondClaimRace,
      cleanupRead,
      cleanupWrite,
    ]);
    const randomIds = [ids.generation, ids.claim, secondGeneration, secondClaim];

    await expect(captureRoutingAssignmentGuards(
      client as never,
      ids.organization,
      [ids.extension, ids.extension2],
      "dispatch.routing.apply",
      ids.routingOperation,
      { now: () => now, randomId: () => randomIds.shift() as string },
    )).rejects.toMatchObject({ status: 409 });
    expect(cleanupWrite.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: { assignmentGeneration: ids.generation },
    });
  });

  it("rejects a listener guard after assignment generation or action claim changes", async () => {
    const changedRow = extensionRow({
      metadata: {
        ...actionMetadata("call.create"),
        assignmentGeneration: "88888888-8888-4888-8888-888888888888",
      },
    });
    const changed = queryResult({ data: changedRow, error: null });
    await expect(revalidateExtensionAssignmentGuard(
      sequentialClient([changed, ...immutableLifecycleQueries(changedRow)]) as never,
      ids.organization,
      {
        claimId: ids.claim,
        extension: "20",
        extensionId: ids.extension,
        generation: ids.generation,
        lifecycleEpoch: ids.lifecycle,
        profileId: ids.actor,
      },
    )).rejects.toBeInstanceOf(AssignmentInterlockRejected);
  });

  it("rejects an action when the mutable extension row is missing its immutable lifecycle mirror", async () => {
    const row = extensionRow({}, false);
    const client = sequentialClient([
      queryResult({ data: row, error: null }),
      ...immutableLifecycleQueries(extensionRow()),
    ]);

    await expect(claimOwnedExtensionAction(actor, ids.extension, "call.create", {
      client: client as never,
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("nezodpovedá nemennému assignment auditu"),
    });
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it("rejects an action when the immutable lifecycle audit was tampered", async () => {
    const row = extensionRow();
    const tampered = {
      ...assignmentLifecycleFor(row),
      epoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const client = sequentialClient([
      queryResult({ data: row, error: null }),
      ...immutableLifecycleQueries(row, tampered),
    ]);

    await expect(claimOwnedExtensionAction(actor, ids.extension, "call.create", {
      client: client as never,
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("nezodpovedá nemennému assignment auditu"),
    });
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it("reconciles only the exact terminal command claim without scanning unrelated history", async () => {
    const claimedRow = extensionRow({ metadata: actionMetadata("call.create") });
    const commands = queryResult({
      data: [{
        id: "terminal-command",
        status: "failed",
        request_payload: { assignmentGuard: assignmentGuard() },
      }],
      error: null,
    });
    const releaseRead = queryResult({ data: claimedRow, error: null });
    const releaseWrite = queryResult({ data: { id: ids.extension }, error: null });
    const client = sequentialClient([
      queryResult({ data: claimedRow, error: null }),
      commands,
      releaseRead,
      releaseWrite,
    ]);

    await reconcileTerminalExtensionAssignmentClaim(client as never, ids.organization, ids.extension);

    expect(commands.calls).toContainEqual({ method: "contains", args: [
      "request_payload",
      { assignmentGuard: { claimId: ids.claim, generation: ids.generation } },
    ] });
    expect(commands.calls).toContainEqual({ method: "limit", args: [3] });
    const metadata = releaseWrite.calls.find(({ method }) => method === "update")?.args[0] as { metadata: Json };
    expect(metadata.metadata).not.toHaveProperty("assignmentActionClaim");
  });

  it("keeps the exact claim while its matching command is still non-terminal", async () => {
    const claimedRow = extensionRow({ metadata: actionMetadata("call.create") });
    const client = sequentialClient([
      queryResult({ data: claimedRow, error: null }),
      queryResult({ data: [{
        id: "pending-command",
        status: "accepted",
        request_payload: { assignmentGuard: assignmentGuard() },
      }], error: null }),
    ]);

    await reconcileTerminalExtensionAssignmentClaim(client as never, ids.organization, ids.extension);
    expect(client.from).toHaveBeenCalledTimes(2);
  });

  it.each(["complete", "partial"] as const)(
    "releases an accepted DTMF %s delivery only after provider-idle proof",
    async (outcome) => {
      const claimedRow = extensionRow({ metadata: actionMetadata("call.transfer.dtmf") });
      const accepted = {
        id: "77777777-7777-4777-8777-777777777777",
        call_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        command_type: "call.transfer.dtmf",
        status: "accepted",
        provider_response: { browserDtmfDelivery: { outcome } },
        request_payload: { assignmentGuard: assignmentGuard() },
      };
      const blocked = sequentialClient([
        queryResult({ data: claimedRow, error: null }),
        queryResult({ data: [accepted], error: null }),
      ]);
      await reconcileTerminalExtensionAssignmentClaim(blocked as never, ids.organization, ids.extension);
      expect(blocked.from).toHaveBeenCalledTimes(2);

      const released = sequentialClient([
        queryResult({ data: claimedRow, error: null }),
        queryResult({ data: [accepted], error: null }),
        queryResult({ data: claimedRow, error: null }),
        queryResult({ data: { id: ids.extension }, error: null }),
      ]);
      await reconcileTerminalExtensionAssignmentClaim(released as never, ids.organization, ids.extension, {
        providerIdleProven: true,
        providerProofAt: now,
      });
      expect(released.from).toHaveBeenCalledTimes(4);
    },
  );

  it("releases a stranded accepted DTMF claim when its exact call is terminal and the provider is idle", async () => {
    const callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const claimedRow = extensionRow({ metadata: actionMetadata("call.transfer.dtmf") });
    const accepted = {
      id: "77777777-7777-4777-8777-777777777777",
      call_id: callId,
      command_type: "call.transfer.dtmf",
      status: "accepted",
      provider_response: {},
      request_payload: { assignmentGuard: assignmentGuard() },
    };
    const terminalCall = queryResult({ data: [{ id: callId, status: "ended" }], error: null });
    const client = sequentialClient([
      queryResult({ data: claimedRow, error: null }),
      queryResult({ data: [accepted], error: null }),
      queryResult({ data: [], error: null }),
      terminalCall,
      queryResult({ data: claimedRow, error: null }),
      queryResult({ data: { id: ids.extension }, error: null }),
    ]);

    await reconcileTerminalExtensionAssignmentClaim(client as never, ids.organization, ids.extension, {
      providerIdleProven: true,
      providerProofAt: now,
    });

    expect(terminalCall.calls).toContainEqual({ method: "in", args: ["status", [
      "ended",
      "failed",
      "missed",
      "abandoned_queue",
    ]] });
    expect(client.from).toHaveBeenCalledTimes(6);
  });

  it("keeps a stranded accepted DTMF claim while its exact call is not terminal", async () => {
    const callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const claimedRow = extensionRow({ metadata: actionMetadata("call.transfer.dtmf") });
    const accepted = {
      id: "77777777-7777-4777-8777-777777777777",
      call_id: callId,
      command_type: "call.transfer.dtmf",
      status: "accepted",
      provider_response: {},
      request_payload: { assignmentGuard: assignmentGuard() },
    };
    const client = sequentialClient([
      queryResult({ data: claimedRow, error: null }),
      queryResult({ data: [accepted], error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
    ]);

    await reconcileTerminalExtensionAssignmentClaim(client as never, ids.organization, ids.extension, {
      providerIdleProven: true,
      providerProofAt: now,
    });

    expect(client.from).toHaveBeenCalledTimes(4);
  });

  it("releases a stranded accepted SIP REFER claim only after provider-idle proof", async () => {
    const claimedRow = extensionRow({ metadata: actionMetadata("call.transfer.sip_refer") });
    const accepted = {
      id: "77777777-7777-4777-8777-777777777777",
      call_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      command_type: "call.transfer.sip_refer",
      status: "accepted",
      provider_response: {},
      request_payload: { assignmentGuard: assignmentGuard() },
    };
    const blocked = sequentialClient([
      queryResult({ data: claimedRow, error: null }),
      queryResult({ data: [accepted], error: null }),
    ]);
    await reconcileTerminalExtensionAssignmentClaim(blocked as never, ids.organization, ids.extension);
    expect(blocked.from).toHaveBeenCalledTimes(2);

    const released = sequentialClient([
      queryResult({ data: claimedRow, error: null }),
      queryResult({ data: [accepted], error: null }),
      queryResult({ data: claimedRow, error: null }),
      queryResult({ data: { id: ids.extension }, error: null }),
    ]);
    await reconcileTerminalExtensionAssignmentClaim(released as never, ids.organization, ids.extension, {
      providerIdleProven: true,
      providerProofAt: now,
    });
    expect(released.from).toHaveBeenCalledTimes(4);
  });

  it("recovers a crashed webphone issuance claim only after grace and provider-idle proof", async () => {
    const claimedRow = extensionRow({
      metadata: actionMetadata("webphone.session.issue", "2026-08-04T16:00:00.000Z"),
    });
    const client = sequentialClient([
      queryResult({ data: claimedRow, error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: claimedRow, error: null }),
      queryResult({ data: { id: ids.extension }, error: null }),
    ]);

    await reconcileTerminalExtensionAssignmentClaim(client as never, ids.organization, ids.extension, {
      providerIdleProven: true,
      providerProofAt: now,
    });
    expect(client.from).toHaveBeenCalledTimes(4);
  });

  it("backs out the exact action when a workplace resource claim won before the post-check", async () => {
    const claimedRow = extensionRow({ metadata: actionMetadata("call.create") });
    const releaseWrite = queryResult({ data: { id: ids.extension }, error: null });
    const client = sequentialClient([
      queryResult({ data: { operation_id: ids.routingOperation, claim_generation: ids.generation }, error: null }),
      queryResult({ data: claimedRow, error: null }),
      releaseWrite,
    ]);

    await expect(assertNoWorkplaceResourceClaimAfterAction(
      client as never,
      ids.organization,
      assignmentGuard(),
    )).rejects.toMatchObject({ status: 409, code: "lease_transitioning" });
    const write = releaseWrite.calls.find(({ method }) => method === "update")?.args[0] as { metadata: Json };
    expect(write.metadata).not.toHaveProperty("assignmentActionClaim");
  });

  it("lets the action proceed when no workplace operation owns the shared extension claim", async () => {
    const client = sequentialClient([
      queryResult({ data: { operation_id: null, claim_generation: null }, error: null }),
    ]);
    await expect(assertNoWorkplaceResourceClaimAfterAction(
      client as never,
      ids.organization,
      assignmentGuard(),
    )).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledTimes(1);
  });
});

function assignmentGuard() {
  return {
    claimId: ids.claim,
    extension: "20",
    extensionId: ids.extension,
    generation: ids.generation,
    lifecycleEpoch: ids.lifecycle,
    profileId: ids.actor,
  };
}

function webphoneLeaseFence() {
  return {
    leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    assignmentGeneration: ids.lifecycle,
    browserInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    leaderEpoch: 1,
    leaseVersion: 1,
  };
}

function selfServiceRoutingRoot(guard: ReturnType<typeof assignmentGuard> & { routingOperationId: string }) {
  return {
    metadata: {
      dispatchRouting: {
        revision: 1,
        currentPlan: { "601": "20", "602": null, "603": null },
        operation: {
          operationId: ids.routingOperation,
          status: "applying",
          actorProfileId: ids.actor,
          previousPlan: { "601": "20", "602": null, "603": null },
          targetPlan: { "601": "20", "602": null, "603": null },
          assignmentGuards: [guard],
          rootMetadataGuard: {
            key: "workplacePriorityDraft",
            digest: "a".repeat(64),
            authorityId: ids.transition,
          },
        },
      },
    },
  };
}

function actionMetadata(action: string, claimedAt = now, routingOperationId?: string) {
  return {
    assignmentGeneration: ids.generation,
    assignmentActionClaim: {
      action,
      claimId: ids.claim,
      claimedAt,
      generation: ids.generation,
      lifecycleEpoch: ids.lifecycle,
      profileId: ids.actor,
      ...(routingOperationId ? { routingOperationId } : {}),
    },
  };
}

function extensionRow(overrides: Record<string, unknown> = {}, includeLifecycle = true) {
  const id = typeof overrides.id === "string" ? overrides.id : ids.extension;
  const extension = typeof overrides.extension === "string" ? overrides.extension : "20";
  const profileId = typeof overrides.profile_id === "string" ? overrides.profile_id : ids.actor;
  const metadata = overrides.metadata && typeof overrides.metadata === "object" && !Array.isArray(overrides.metadata)
    ? overrides.metadata as Record<string, unknown>
    : {};
  const row = {
    id: ids.extension,
    extension: "20",
    profile_id: ids.actor,
    active: true,
    updated_at: "extension-v1",
    ...overrides,
    metadata,
  };
  return {
    ...row,
    metadata: (includeLifecycle
      ? { assignmentLifecycle: assignmentLifecycleFor({ id, extension, profile_id: profileId }), ...metadata }
      : metadata) as Json,
  };
}

function assignmentLifecycleFor(row: { id: string; extension: string; profile_id: string }) {
  return {
    schemaVersion: 1,
    epoch: row.id === ids.extension2 ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab" : ids.lifecycle,
    state: "assigned",
    extensionId: row.id,
    extension: row.extension,
    profileId: row.profile_id,
    assignmentMode: "initial_provisioning",
    assignedAt: "2026-08-04T16:00:00.000Z",
    assignedBy: ids.actor,
  };
}

function immutableLifecycleQueries(
  row: ReturnType<typeof extensionRow>,
  auditedLifecycle: unknown = assignmentLifecycleFor(row),
) {
  return [
    queryResult({
      data: {
        id: `assignment-audit-${row.extension}`,
        action: "telephony.extension.assign",
        after_payload: { assignment_lifecycle: auditedLifecycle },
        created_at: "2026-08-04T16:00:00.000Z",
      },
      error: null,
    }),
    queryResult({
      data: { id: row.profile_id, phone_extension: row.extension },
      error: null,
    }),
  ];
}

function sequentialClient(results: Array<ReturnType<typeof queryResult>>) {
  let index = 0;
  return {
    from: vi.fn(() => {
      const result = results[index++];
      if (!result) throw new Error(`Unexpected database query at index ${index - 1}.`);
      return result.query;
    }),
  };
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
