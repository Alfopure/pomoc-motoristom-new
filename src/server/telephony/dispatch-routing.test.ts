import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Json } from "@/lib/supabase/database.types";
import type { ViptelQueueStatus } from "@/lib/integrations/viptel/client";
import {
  assertCompleteDispatchQueueStatuses,
  assertDispatchPlanCanStart,
  assertDispatchOperationCurrentCommandRecoverable,
  assertEmptyDispatchBootstrapOperationShape,
  assertEmptyDispatchBootstrapState,
  assertRoutingAssignmentGuardCoverage,
  advanceDispatchRoutingOperationForConfirmedCommand,
  blockingDispatchQueueCommands,
  compareAndSetDispatchRoutingState,
  dispatchRoutingCommittedPlanDigest,
  dispatchRoutingOperationAuthorityDigest,
  dispatchRoutingPreviewDigest,
  dispatchRoutingRootMetadataDigest,
  dispatchRecoveryIsRollingBack,
  type DispatchRoutingFallback,
  type DispatchRoutingStep,
  DispatchRoutingCommandRejected,
  hasUnresolvedDispatchDelivery,
  markDispatchRoutingCommandFailed,
  planDispatchQueueCatalog,
  planFromDispatchPrioritySlots,
  parseDispatchRoutingState,
  readApplicableWorkplacePriorityDraft,
  revalidateDispatchQueueCommand,
  validateEmptyDispatchBootstrapOperation,
  validateEmptyDispatchBootstrapRecoverySnapshot,
  validateEmptyDispatchBootstrapStart,
  validateDispatchControlledWindow,
  validateDispatchStepObservedState,
} from "./dispatch-routing";
import { authorizeWorkplacePriorityDraft } from "./workplace-draft-authority";
import type { TelephonyCommandRow } from "./viptel-command-outbox";

const organizationId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const availabilityExtensionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const availabilityProfileId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const workplaceAuthorityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workplaceServiceSecret = "test-workplace-authority-secret-at-least-32-characters";

beforeEach(() => {
  process.env.SUPABASE_SECRET_KEY = workplaceServiceSecret;
});

afterEach(() => delete process.env.SUPABASE_SECRET_KEY);

describe("listener-side dispatch routing revalidation", () => {
  it("reloads the exact current operation and live fallback state before allowing a priority step", async () => {
    const root = queryResult({ data: rootQueue(), error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: priorityPayload() }], error: null });
    const client = sequentialClient([root, ...routingValidationQueries(routingOperation()), pending, ...assignmentGuardQueries()]);
    const order: string[] = [];
    const viptel = provider({ order });

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, priorityCommand(), viptel)).resolves.toBeUndefined();
    expect(order).toEqual(["extensions", "601", "602", "603", "activeCalls"]);
    expect(root.calls).toContainEqual({ method: "eq", args: ["external_id", "601"] });
    expect(pending.calls).toContainEqual({ method: "in", args: ["status", ["queued", "sent", "accepted"]] });
  });

  it("accepts an immutable operation authority after JSONB reorders object keys", async () => {
    const operation = routingOperation();
    const authorityRow = routingAuthorityRow(operation);
    const storedAuthority = authorityRow.after_payload.routing_operation_authority;
    authorityRow.after_payload.routing_operation_authority = {
      ...storedAuthority,
      intent: reverseObjectKeysDeep(storedAuthority.intent),
    };
    const root = queryResult({ data: rootQueue(), error: null });
    const authority = queryResult({ data: [authorityRow], error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: priorityPayload() }], error: null });
    const client = sequentialClient([
      root,
      authority,
      routingProgressQuery(operation),
      pending,
      ...assignmentGuardQueries(),
    ]);
    const viptel = provider();

    await expect(revalidateDispatchQueueCommand(
      client as never,
      organizationId,
      priorityCommand(),
      viptel,
    )).resolves.toBeUndefined();
    expect(viptel.listExtensions).toHaveBeenCalledTimes(1);
    expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
  });

  it("preserves the guarded self-service mode when the listener revalidates registered idle extensions", async () => {
    const authorized = authorizedWorkplaceDraft(2, workplaceAuthorityId);
    const draft = authorized.draft;
    const rootMetadataGuard = {
      key: "workplacePriorityDraft" as const,
      digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", draft),
      authorityId: workplaceAuthorityId,
    };
    const operation = { ...routingOperation(), rootMetadataGuard };
    const rootData = rootQueue({ operation });
    (rootData.metadata as Record<string, unknown>).workplacePriorityDraft = draft;
    const root = queryResult({ data: rootData, error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: priorityPayload() }], error: null });
    const draftAuthority = queryResult({
      data: [workplaceDraftAuthorityRow(authorized, workplaceAuthorityId)],
      error: null,
    });
    const client = sequentialClient([
      root,
      ...routingValidationQueries(operation),
      pending,
      draftAuthority,
      ...assignmentGuardQueries(),
    ]);
    const command = priorityCommand();
    command.request_payload = {
      ...priorityPayload(),
      routingOperation: {
        ...priorityPayload().routingOperation,
        authorityDigest: dispatchRoutingOperationAuthorityDigest(organizationId, operation as never),
      },
    };

    await expect(revalidateDispatchQueueCommand(
      client as never,
      organizationId,
      command,
      provider({ registeredExtensions: ["20", "21"] }),
    )).resolves.toBeUndefined();
  });

  it("revalidates an empty bootstrap with registered targets and no active calls before its first add", async () => {
    const root = queryResult({ data: bootstrapRootQueue(), error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: bootstrapPriorityPayload() }], error: null });
    const client = sequentialClient([
      root,
      ...routingValidationQueries(bootstrapListenerOperation()),
      pending,
      ...bootstrapAssignmentGuardQueries(),
    ]);
    const viptel = bootstrapListenerProvider();

    await expect(
      revalidateDispatchQueueCommand(client as never, organizationId, bootstrapPriorityCommand(), viptel),
    ).resolves.toBeUndefined();
    expect(viptel.listActiveCalls).toHaveBeenCalledTimes(1);
    expect(viptel.listExtensions).toHaveBeenCalledTimes(1);
    expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
  });

  it("degrades an empty bootstrap when a call appears before provider queue I/O", async () => {
    const rootData = bootstrapRootQueue();
    const root = queryResult({ data: rootData, error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: bootstrapPriorityPayload() }], error: null });
    const degraded = queryResult({ data: rootData, error: null });
    const client = sequentialClient([
      root,
      ...routingValidationQueries(bootstrapListenerOperation()),
      pending,
      ...bootstrapAssignmentGuardQueries(),
      degraded,
    ]);
    const viptel = bootstrapListenerProvider({
      activeCalls: [{ direction: "inbound", status: "incoming", raw: {} }],
    });

    await expect(
      revalidateDispatchQueueCommand(client as never, organizationId, bootstrapPriorityCommand(), viptel),
    ).rejects.toMatchObject({ message: expect.stringContaining("bez aktívnych VIPTel hovorov") });
    expect(degraded.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: { dispatchRouting: { operation: { status: "degraded" } } },
    });
  });

  it("blocks an empty bootstrap before provider reads when another telephony command is pending", async () => {
    const root = queryResult({ data: bootstrapRootQueue(), error: null });
    const pending = queryResult({
      data: [
        { id: commandId, command_type: "queue.add", status: "sent" },
        { id: "foreign-command", command_type: "call.create", status: "queued" },
      ],
      error: null,
    });
    const client = sequentialClient([root, ...routingValidationQueries(bootstrapListenerOperation()), pending]);
    const viptel = bootstrapListenerProvider();

    await expect(
      revalidateDispatchQueueCommand(client as never, organizationId, bootstrapPriorityCommand(), viptel),
    ).rejects.toThrow("prázdnu frontu telekomunikačných príkazov");
    expect(viptel.listActiveCalls).not.toHaveBeenCalled();
    expect(viptel.listExtensions).not.toHaveBeenCalled();
    expect(viptel.getQueueStatus).not.toHaveBeenCalled();
  });

  it("rejects a stale step before any provider state or queue action is requested", async () => {
    const staleRoot = rootQueue();
    const metadata = staleRoot.metadata as Record<string, unknown>;
    const routing = metadata.dispatchRouting as Record<string, unknown>;
    routing.operation = { ...(routing.operation as Record<string, unknown>), currentStep: 1 };
    const root = queryResult({ data: staleRoot, error: null });
    const client = sequentialClient([root]);
    const viptel = provider();

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, priorityCommand(), viptel)).rejects.toBeInstanceOf(
      DispatchRoutingCommandRejected,
    );
    expect(viptel.listExtensions).not.toHaveBeenCalled();
    expect(viptel.getQueueStatus).not.toHaveBeenCalled();
  });

  it("rejects a restored old operation after a newer global routing commit before provider access", async () => {
    const operation = routingOperation();
    const root = queryResult({ data: rootQueue(), error: null });
    const oldAuthority = { ...routingAuthorityRow(operation), id: "10000000-0000-4000-8000-000000000000" };
    const newerCommit = {
      ...committedPlanRow(rootQueue({ operation: null })),
      id: "20000000-0000-4000-8000-000000000000",
      created_at: "2026-08-04T17:00:00.000Z",
    };
    const head = queryResult({ data: [newerCommit, oldAuthority], error: null });
    const client = sequentialClient([root, head]);
    const viptel = provider();

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, priorityCommand(), viptel))
      .rejects.toThrow("nezodpovedá nemennej serverovej autorizácii");
    expect(client.from).toHaveBeenCalledTimes(2);
    expectGlobalHeadQuery(head);
    expect(viptel.listExtensions).not.toHaveBeenCalled();
    expect(viptel.getQueueStatus).not.toHaveBeenCalled();
  });

  it("rejects a stable restored plan when a newer global operation authority shadows its old commit", async () => {
    const stableRoot = rootQueue({ operation: null });
    const root = queryResult({ data: stableRoot, error: null });
    const oldCommit = committedPlanRow(stableRoot);
    const newerAuthority = {
      ...routingAuthorityRow(foreignRoutingOperation()),
      created_at: "2026-08-04T17:00:00.000Z",
    };
    const head = queryResult({ data: [newerAuthority, oldCommit], error: null });
    const client = sequentialClient([root, head]);
    const viptel = provider();

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, availabilityCommand(), viptel))
      .rejects.toThrow("nezodpovedá nemennému potvrdenému auditu");
    expect(client.from).toHaveBeenCalledTimes(2);
    expectGlobalHeadQuery(head);
    expect(viptel.listExtensions).not.toHaveBeenCalled();
    expect(viptel.getQueueStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["authority UUID sorts first", "ffffffff-ffff-4fff-8fff-ffffffffffff", "00000000-0000-4000-8000-000000000001"],
    ["commit UUID sorts first", "00000000-0000-4000-8000-000000000001", "ffffffff-ffff-4fff-8fff-ffffffffffff"],
  ])("fails closed for an equal-time global head when %s", async (_label, authorityId, commitId) => {
    const timestamp = "2026-08-04T17:00:00.000Z";
    const authority = { ...routingAuthorityRow(routingOperation()), id: authorityId, created_at: timestamp };
    const commit = { ...committedPlanRow(rootQueue({ operation: null })), id: commitId, created_at: timestamp };
    const rows = [authority, commit].sort((left, right) => right.id.localeCompare(left.id));

    const operationHead = queryResult({ data: rows, error: null });
    const operationProvider = provider();
    await expect(revalidateDispatchQueueCommand(
      sequentialClient([
        queryResult({ data: rootQueue(), error: null }),
        operationHead,
      ]) as never,
      organizationId,
      priorityCommand(),
      operationProvider,
    )).rejects.toThrow("nejednoznačné poradie");
    expectGlobalHeadQuery(operationHead);
    expect(operationProvider.listExtensions).not.toHaveBeenCalled();

    const availabilityHead = queryResult({ data: rows, error: null });
    const availabilityProvider = provider();
    await expect(revalidateDispatchQueueCommand(
      sequentialClient([
        queryResult({ data: rootQueue({ operation: null }), error: null }),
        availabilityHead,
      ]) as never,
      organizationId,
      availabilityCommand(),
      availabilityProvider,
    )).rejects.toThrow("nejednoznačné poradie");
    expectGlobalHeadQuery(availabilityHead);
    expect(availabilityProvider.listExtensions).not.toHaveBeenCalled();
  });

  it("degrades the durable operation and refuses execution when fallback coverage disappears", async () => {
    const rootData = rootQueue();
    const root = queryResult({ data: rootData, error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: priorityPayload() }], error: null });
    const degraded = queryResult({ data: rootData, error: null });
    const client = sequentialClient([root, ...routingValidationQueries(routingOperation()), pending, ...assignmentGuardQueries(), degraded]);
    const viptel = provider({ fallbackRegistered: false });

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, priorityCommand(), viptel)).rejects.toMatchObject({
      message: expect.stringContaining("Nezávislá záloha"),
    });
    const update = degraded.calls.find((call) => call.method === "update")?.args[0] as { metadata: Record<string, unknown> };
    expect(update.metadata).toMatchObject({
      dispatchRouting: { operation: { status: "degraded" } },
    });
  });

  it("degrades and refuses a step when observed membership drifted after planning", async () => {
    const rootData = rootQueue();
    const root = queryResult({ data: rootData, error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: priorityPayload() }], error: null });
    const degraded = queryResult({ data: rootData, error: null });
    const client = sequentialClient([root, ...routingValidationQueries(routingOperation()), pending, ...assignmentGuardQueries(), degraded]);
    const viptel = provider({ currentMember: true });

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, priorityCommand(), viptel)).rejects.toMatchObject({
      message: expect.stringContaining("už nezodpovedá kroku add"),
    });
    expect(degraded.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: { dispatchRouting: { operation: { status: "degraded" } } },
    });
  });

  it("degrades and refuses execution when VIPTel duplicates one queue status and omits another", async () => {
    const rootData = rootQueue();
    const root = queryResult({ data: rootData, error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: priorityPayload() }], error: null });
    const degraded = queryResult({ data: rootData, error: null });
    const client = sequentialClient([root, ...routingValidationQueries(routingOperation()), pending, ...assignmentGuardQueries(), degraded]);
    const viptel = provider({ reportedQueue: { "602": "601" } });

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, priorityCommand(), viptel)).rejects.toMatchObject({
      message: expect.stringContaining("práve jeden aktuálny stav"),
    });
    expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
    expect(degraded.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: { dispatchRouting: { operation: { status: "degraded" } } },
    });
  });

  it("degrades before a queue write when VIPTel duplicates a relevant extension row", async () => {
    const rootData = rootQueue();
    const root = queryResult({ data: rootData, error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: priorityPayload() }], error: null });
    const degraded = queryResult({ data: rootData, error: null });
    const client = sequentialClient([root, ...routingValidationQueries(routingOperation()), pending, ...assignmentGuardQueries(), degraded]);
    const viptel = provider({ duplicateExtension: "20" });

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, priorityCommand(), viptel)).rejects.toMatchObject({
      message: expect.stringContaining("duplicitný alebo konfliktný záznam klapky 20"),
    });
    expect(viptel.listExtensions).toHaveBeenCalledTimes(1);
    expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
    expect(degraded.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: { dispatchRouting: { operation: { status: "degraded" } } },
    });
  });

  it("degrades before a queue write when VIPTel duplicates a member inside one controlled queue", async () => {
    const rootData = rootQueue();
    const root = queryResult({ data: rootData, error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: priorityPayload() }], error: null });
    const degraded = queryResult({ data: rootData, error: null });
    const client = sequentialClient([root, ...routingValidationQueries(routingOperation()), pending, ...assignmentGuardQueries(), degraded]);
    const viptel = provider({ duplicateMember: { queue: "603", extension: "23" } });

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, priorityCommand(), viptel)).rejects.toMatchObject({
      message: expect.stringContaining("duplicitné alebo konfliktné členstvo 603/23"),
    });
    expect(viptel.listExtensions).toHaveBeenCalledTimes(1);
    expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
    expect(degraded.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: { dispatchRouting: { operation: { status: "degraded" } } },
    });
  });

  it("degrades before provider access when an assignment generation changed after enqueue", async () => {
    const rootData = rootQueue();
    const root = queryResult({ data: rootData, error: null });
    const pending = queryResult({ data: [{ id: commandId, request_payload: priorityPayload() }], error: null });
    const guard = routingAssignmentGuards()[0];
    const staleAssignment = queryResult({
      data: {
        id: guard.extensionId,
        extension: guard.extension,
        profile_id: guard.profileId,
        active: true,
        metadata: {
          assignmentGeneration: "changed-generation",
          assignmentLifecycle: assignmentLifecycleForGuard(guard),
          assignmentActionClaim: {
            action: "dispatch.routing.apply",
            claimId: guard.claimId,
            generation: "changed-generation",
            lifecycleEpoch: guard.lifecycleEpoch,
            profileId: guard.profileId,
            routingOperationId: operationId,
          },
        },
      },
      error: null,
    });
    const degraded = queryResult({ data: rootData, error: null });
    const client = sequentialClient([
      root,
      ...routingValidationQueries(routingOperation()),
      pending,
      staleAssignment,
      ...immutableAssignmentQueries(guard),
      degraded,
    ]);
    const viptel = provider();

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, priorityCommand(), viptel)).rejects.toMatchObject({
      message: expect.stringContaining("generácia osobnej klapky"),
    });
    expect(viptel.listExtensions).not.toHaveBeenCalled();
    expect(viptel.getQueueStatus).not.toHaveBeenCalled();
    expect(degraded.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: { dispatchRouting: { operation: { status: "degraded" } } },
    });
  });

  it("rejects an untagged legacy command for dispatch queues 601-603", async () => {
    const root = queryResult({ data: rootQueue({ operation: null }), error: null });
    const client = sequentialClient([root]);
    const command = priorityCommand();
    command.request_payload = { queue: "601", extension: "20", action: "add" };
    await expect(revalidateDispatchQueueCommand(client as never, organizationId, command, provider())).rejects.toMatchObject({
      message: expect.stringContaining("serverom podpísaný routing kontext"),
    });
  });

  it("rejects queue commands outside the controlled 601-603 catalog before provider access", async () => {
    const client = sequentialClient([]);
    const viptel = provider();
    const command = priorityCommand();
    command.request_payload = { queue: "500", extension: "20", action: "add" };

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, command, viptel)).rejects.toMatchObject({
      message: expect.stringContaining("mimo riadených radov 601–603"),
    });
    expect(client.from).not.toHaveBeenCalled();
    expect(viptel.listExtensions).not.toHaveBeenCalled();
    expect(viptel.getQueueStatus).not.toHaveBeenCalled();
  });

  it("accepts only availability tagged with the current revision and planned queue", async () => {
    const root = queryResult({ data: rootQueue({ operation: null }), error: null });
    const ownership = queryResult({ data: { id: availabilityExtensionId }, error: null });
    const ordering = queryResult({
      data: [{ id: commandId, request_payload: availabilityPayload(), created_at: "2026-08-04T16:00:00.000Z" }],
      error: null,
    });
    const client = sequentialClient([
      root,
      committedPlanQuery(rootQueue({ operation: null })),
      ownership,
      ordering,
      ...availabilityAssignmentQueries(),
    ]);
    const command = priorityCommand();
    command.request_payload = availabilityPayload();
    command.extension_id = availabilityExtensionId;
    command.requested_by = availabilityProfileId;
    await expect(revalidateDispatchQueueCommand(client as never, organizationId, command, provider())).resolves.toBeUndefined();
    expect(ownership.calls).toContainEqual({ method: "eq", args: ["profile_id", availabilityProfileId] });
    expect(ordering.calls).toContainEqual({ method: "order", args: ["created_at", { ascending: true }] });
    expect(ordering.calls).toContainEqual({ method: "order", args: ["id", { ascending: true }] });
  });

  it("admits only the oldest exact availability command under concurrent enqueue", async () => {
    const root = queryResult({ data: rootQueue({ operation: null }), error: null });
    const ownership = queryResult({ data: { id: availabilityExtensionId }, error: null });
    const ordering = queryResult({
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          request_payload: availabilityPayload(),
          created_at: "2026-08-04T15:59:59.000Z",
        },
        { id: commandId, request_payload: availabilityPayload(), created_at: "2026-08-04T16:00:00.000Z" },
      ],
      error: null,
    });
    const client = sequentialClient([root, committedPlanQuery(rootQueue({ operation: null })), ownership, ordering]);
    const viptel = provider();
    const command = priorityCommand();
    command.request_payload = availabilityPayload();
    command.extension_id = availabilityExtensionId;
    command.requested_by = availabilityProfileId;

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, command, viptel)).rejects.toMatchObject({
      message: expect.stringContaining("iba najstarší"),
    });
    expect(viptel.getQueueStatus).not.toHaveBeenCalled();
  });

  it("rejects an availability step when the full provider snapshot duplicates a queue identity", async () => {
    const root = queryResult({ data: rootQueue({ operation: null }), error: null });
    const ownership = queryResult({ data: { id: availabilityExtensionId }, error: null });
    const ordering = queryResult({
      data: [{ id: commandId, request_payload: availabilityPayload(), created_at: "2026-08-04T16:00:00.000Z" }],
      error: null,
    });
    const client = sequentialClient([
      root,
      committedPlanQuery(rootQueue({ operation: null })),
      ownership,
      ordering,
      ...availabilityAssignmentQueries(),
    ]);
    const viptel = provider({ reportedQueue: { "602": "601" } });
    const command = priorityCommand();
    command.request_payload = availabilityPayload();
    command.extension_id = availabilityExtensionId;
    command.requested_by = availabilityProfileId;

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, command, viptel)).rejects.toMatchObject({
      message: expect.stringContaining("práve jeden aktuálny stav"),
    });
    expect(viptel.listExtensions).toHaveBeenCalledTimes(1);
    expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
  });

  it("rejects availability if extension ownership changed after enqueue", async () => {
    const root = queryResult({ data: rootQueue({ operation: null }), error: null });
    const ownership = queryResult({ data: null, error: null });
    const client = sequentialClient([root, committedPlanQuery(rootQueue({ operation: null })), ownership]);
    const command = priorityCommand();
    command.request_payload = {
      queue: "601",
      extension: "20",
      action: "pause",
      routingAvailability: {
        kind: "availability",
        queue: "601",
        extension: "20",
        revision: 2,
        intent: "pause",
        planDigest: testCommittedPlanDigest(),
      },
    };
    command.command_type = "queue.pause";
    command.extension_id = availabilityExtensionId;
    command.requested_by = "former-owner";

    await expect(revalidateDispatchQueueCommand(client as never, organizationId, command, provider())).rejects.toMatchObject({
      message: expect.stringContaining("nepatrí pôvodnému operátorovi"),
    });
  });
});

describe("dispatch routing safety contracts", () => {
  it("keeps final completion recoverable until every exact routing claim is released", async () => {
    const rootData = rootQueue();
    const metadata = rootData.metadata as { dispatchRouting: { operation: ReturnType<typeof routingOperation> } };
    metadata.dispatchRouting.operation.currentStep = 1;
    metadata.dispatchRouting.operation.steps[0].status = "confirmed";
    const root = queryResult({ data: rootData, error: null });
    const releasePendingRoot = {
      ...rootData,
      updated_at: "2026-08-04T16:00:01.000Z",
    };
    const releasePending = queryResult({ data: releasePendingRoot, error: null });
    const releaseQueries = routingAssignmentGuards().flatMap((guard) => [
      queryResult({
        data: {
          id: guard.extensionId,
          extension: guard.extension,
          profile_id: guard.profileId,
          active: true,
          metadata: {
            assignmentGeneration: guard.generation,
            assignmentActionClaim: {
              action: "dispatch.routing.apply",
              claimId: guard.claimId,
              generation: guard.generation,
              lifecycleEpoch: guard.lifecycleEpoch,
              profileId: guard.profileId,
              routingOperationId: operationId,
            },
          },
          updated_at: "2026-08-04T16:00:00.000Z",
        },
        error: null,
      }),
      queryResult({ data: { id: guard.extensionId }, error: null }),
    ]);
    const completed = queryResult({ data: { ...releasePendingRoot, updated_at: "2026-08-04T16:00:02.000Z" }, error: null });
    const audit = queryResult({ data: null, error: null });
    const stepConfirmation = queryResult({ data: { id: "routing-step-confirmation" }, error: null });
    const committed = queryResult({ data: { id: "routing-plan-commit" }, error: null });
    const client = sequentialClient([
      root,
      ...routingValidationQueries(metadata.dispatchRouting.operation),
      stepConfirmation,
      releasePending,
      ...releaseQueries,
      completed,
      committed,
      audit,
    ]);
    const command = priorityCommand();
    command.id = "55555555-5555-4555-8555-555555555555";
    command.request_payload = {
      ...priorityPayload(),
      routingOperation: { ...priorityPayload().routingOperation, stepIndex: 1 },
    };

    await expect(advanceDispatchRoutingOperationForConfirmedCommand(client as never, organizationId, command)).resolves.toBe(true);

    const pendingWrite = releasePending.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: { operation: { status: string } } };
    };
    expect(pendingWrite.metadata.dispatchRouting.operation.status).toBe("degraded");
    for (let index = 1; index < releaseQueries.length; index += 2) {
      const releaseWrite = releaseQueries[index].calls.find((call) => call.method === "update")?.args[0] as { metadata: Record<string, unknown> };
      expect(releaseWrite.metadata).not.toHaveProperty("assignmentActionClaim");
    }
    const completedWrite = completed.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: Record<string, unknown> };
    };
    expect(completedWrite.metadata.dispatchRouting).not.toHaveProperty("operation");
  });

  it("leaves a visible release-pending operation and audit when final claim release fails", async () => {
    const rootData = rootQueue();
    const metadata = rootData.metadata as { dispatchRouting: { operation: ReturnType<typeof routingOperation> } };
    metadata.dispatchRouting.operation.currentStep = 1;
    metadata.dispatchRouting.operation.steps[0].status = "confirmed";
    const root = queryResult({ data: rootData, error: null });
    const releasePending = queryResult({
      data: { ...rootData, updated_at: "2026-08-04T16:00:01.000Z" },
      error: null,
    });
    const failedRelease = queryResult({ data: null, error: { message: "database unavailable" } });
    const failureAudit = queryResult({ data: null, error: null });
    const stepConfirmation = queryResult({ data: { id: "routing-step-confirmation" }, error: null });
    const client = sequentialClient([
      root,
      ...routingValidationQueries(metadata.dispatchRouting.operation),
      stepConfirmation,
      releasePending,
      failedRelease,
      failureAudit,
    ]);
    const command = priorityCommand();
    command.id = "55555555-5555-4555-8555-555555555555";
    command.request_payload = {
      ...priorityPayload(),
      routingOperation: { ...priorityPayload().routingOperation, stepIndex: 1 },
    };

    await expect(advanceDispatchRoutingOperationForConfirmedCommand(client as never, organizationId, command)).rejects.toThrow(
      "po ukončení nepodarilo načítať",
    );

    const pendingWrite = releasePending.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: { operation: { status: string; lastError: string } } };
    };
    expect(pendingWrite.metadata.dispatchRouting.operation).toMatchObject({
      status: "degraded",
      lastError: expect.stringContaining("uvoľnenie assignment interlocku"),
    });
    expect(failureAudit.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      action: "telephony.routing.operation.release_failed",
    });
    expect(client.from).toHaveBeenCalledTimes(7);
  });

  it("binds live apply to the exact reviewed routing diff", () => {
    const preview = {
      baseRevision: 2,
      targetRevision: 3,
      previousPlan: [
        { queue: "601" as const, extension: "20" },
        { queue: "602" as const, extension: "21" },
        { queue: "603" as const, extension: "22" },
      ],
      targetPlan: [
        { queue: "601" as const, extension: "21" },
        { queue: "602" as const, extension: "20" },
        { queue: "603" as const, extension: "22" },
      ],
      steps: [{ stepIndex: 0, action: "add" as const, queue: "601" as const, extension: "21" }],
      fallback: { queue: "603" as const, extension: "23" },
    };

    const digest = dispatchRoutingPreviewDigest(preview);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(dispatchRoutingPreviewDigest(preview)).toBe(digest);
    expect(dispatchRoutingPreviewDigest({
      ...preview,
      steps: [{ ...preview.steps[0], extension: "20" }],
    })).not.toBe(digest);
  });

  it("classifies only a current-revision workplace draft as applicable and fails closed otherwise", () => {
    expect(readApplicableWorkplacePriorityDraft({ workplacePriorityDraft: workplaceDraft(1) }, 2)).toBeUndefined();
    const signedCurrent = authorizedWorkplaceDraft(2, workplaceAuthorityId).draft;
    expect(readApplicableWorkplacePriorityDraft(
      { workplacePriorityDraft: signedCurrent },
      2,
      { organizationId, rootQueueId: rootQueue().id },
    )).toEqual({
      "601": "20",
      "602": "21",
      "603": "22",
    });
    expect(() => readApplicableWorkplacePriorityDraft({ workplacePriorityDraft: workplaceDraft(3) }, 2))
      .toThrow("budúcu revíziu");
    expect(() => readApplicableWorkplacePriorityDraft({
      workplacePriorityDraft: {
        ...workplaceDraft(1),
        selectedBy: { "601": "profile-20", "602": null, "603": "profile-22" },
      },
    }, 2)).toThrow("neplatného držiteľa");
  });

  it("parses and authorizes only the digest-only self-service guard", () => {
    const draft = authorizedWorkplaceDraft(2, workplaceAuthorityId).draft;
    const guard = {
      key: "workplacePriorityDraft" as const,
      digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", draft),
      authorityId: workplaceAuthorityId,
    };
    const operation = { ...routingOperation(), rootMetadataGuard: guard };
    const parsed = parseDispatchRoutingState({
      workplacePriorityDraft: draft,
      dispatchRouting: {
        revision: 2,
        currentPlan: { "601": "20", "602": "21", "603": "22" },
        operation,
      },
    });

    expect(parsed.operation?.rootMetadataGuard).toEqual(guard);
    expect(JSON.stringify(parsed.operation?.rootMetadataGuard)).not.toContain("profile-20");
    expect(dispatchRoutingOperationAuthorityDigest(organizationId, operation as never))
      .not.toBe(dispatchRoutingOperationAuthorityDigest(organizationId, routingOperation() as never));
    expect(() => parseDispatchRoutingState({
      dispatchRouting: {
        revision: 2,
        currentPlan: { "601": "20", "602": "21", "603": "22" },
        operation: { ...operation, rootMetadataGuard: { ...guard, rawDraft: draft } },
      },
    })).toThrow("neplatný formát");
  });

  it("rejects malformed, missing and duplicate priority slots", () => {
    expect(() => planFromDispatchPrioritySlots([
      { queue: "601", extension: "20" },
      { queue: "602", extension: "20" },
      { queue: "603", extension: "22" },
    ])).toThrow("nemôže byť vo viacerých prioritách");
    expect(() => planFromDispatchPrioritySlots([
      { queue: "601", extension: "20" },
      { queue: "602", extension: "21" },
    ] as never)).toThrow("presne rady 601, 602 a 603");
  });

  it("requires queue 601-603 catalog rows to exist with line_id null", () => {
    expect(planDispatchQueueCatalog([
      { id: "1", external_id: "601", label: "Dispečing – prvá priorita", line_id: null, active: true },
      { id: "2", external_id: "602", label: "wrong", line_id: "line-1", active: true },
    ])).toEqual({
      ready: false,
      queues: [
        expect.objectContaining({ queue: "601", action: "noop", lineId: null }),
        expect.objectContaining({ queue: "602", action: "update", lineId: "line-1" }),
        expect.objectContaining({ queue: "603", action: "insert" }),
      ],
    });
  });

  it("rejects stale revisions and overlapping durable operations", () => {
    expect(() => assertDispatchPlanCanStart({ revision: 3, currentPlan: { "601": "20", "602": "21", "603": "22" } }, 2))
      .toThrow("zastaraný");
    expect(() => assertDispatchPlanCanStart({
      revision: 3,
      currentPlan: { "601": "20", "602": "21", "603": "22" },
      operation: routingOperation() as never,
    }, 3)).toThrow("ešte nie je ukončená");
  });

  it("allows crash recovery only when the current operation command is absent or terminal and correctly tagged", () => {
    const operation = routingOperation() as never;
    expect(() => assertDispatchOperationCurrentCommandRecoverable(operation, null)).not.toThrow();

    const terminal = priorityCommand();
    terminal.status = "failed";
    expect(() => assertDispatchOperationCurrentCommandRecoverable(operation, terminal)).not.toThrow();
    terminal.status = "confirmed_by_event";
    expect(() => assertDispatchOperationCurrentCommandRecoverable(operation, terminal)).not.toThrow();

    terminal.status = "queued";
    expect(() => assertDispatchOperationCurrentCommandRecoverable(operation, terminal)).toThrow("ešte nie je terminálny");
    terminal.status = "failed";
    terminal.request_payload = { ...priorityPayload(), routingOperation: { ...priorityPayload().routingOperation, operationId: "other" } };
    expect(() => assertDispatchOperationCurrentCommandRecoverable(operation, terminal)).toThrow("nezodpovedá uloženej");
  });

  it("degrades only the exact current routing command after a terminal failure", async () => {
    const root = rootQueue();
    const degraded = queryResult({ data: { ...root, updated_at: "2026-08-04T16:00:01.000Z" }, error: null });
    const client = sequentialClient([
      queryResult({ data: root, error: null }),
      degraded,
    ]);

    await markDispatchRoutingCommandFailed(
      client as never,
      organizationId,
      exactRoutingFailureCommand(),
      "listener rejected current command",
    );

    const update = degraded.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: { operation: { lastError: string; status: string } } };
    };
    expect(update.metadata.dispatchRouting.operation).toMatchObject({
      lastError: "listener rejected current command",
      status: "degraded",
    });
  });

  it("does not let a tampered pre-authority command degrade an operation by copying its routing tag", async () => {
    const root = rootQueue();
    const client = sequentialClient([queryResult({ data: root, error: null })]);
    const tampered = {
      ...exactRoutingFailureCommand(),
      id: "12121212-1212-4121-8121-121212121212",
    };

    await markDispatchRoutingCommandFailed(
      client as never,
      organizationId,
      tampered,
      "untrusted command authority failed",
    );

    expect(client.from).toHaveBeenCalledOnce();
  });

  it("does not let a delayed old failure degrade the rebuilt step after recovery", async () => {
    const previousCommand = exactRoutingFailureCommand();
    const resumed = routingOperation();
    resumed.steps = [{
      ...resumed.steps[0],
      commandId: "13131313-1313-4131-8131-131313131313",
      idempotencyKey: "recovered-routing-step",
    }];
    resumed.currentStep = 0;
    resumed.updatedAt = "2026-08-04T16:01:00.000Z";
    const client = sequentialClient([
      queryResult({ data: rootQueue({ operation: resumed }), error: null }),
    ]);

    await markDispatchRoutingCommandFailed(
      client as never,
      organizationId,
      previousCommand,
      "late terminal response from the previous step",
    );

    expect(client.from).toHaveBeenCalledOnce();
  });

  it("requires complete assignment guards bound to every plan, step and fallback extension", () => {
    const operation = routingOperation();
    expect(() => assertRoutingAssignmentGuardCoverage(operation as never)).not.toThrow();
    expect(() => assertRoutingAssignmentGuardCoverage({
      ...operation,
      assignmentGuards: operation.assignmentGuards.slice(0, -1),
    } as never)).toThrow("úplné assignment snapshoty");
    expect(() => assertRoutingAssignmentGuardCoverage({
      ...operation,
      assignmentGuards: operation.assignmentGuards.map((guard) => guard.extension === "20"
        ? { ...guard, extensionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }
        : guard),
    } as never)).toThrow("úplné assignment snapshoty");
    for (const routingOperationId of [undefined, "99999999-9999-4999-8999-999999999999"]) {
      expect(() => assertRoutingAssignmentGuardCoverage({
        ...operation,
        assignmentGuards: operation.assignmentGuards.map((guard, index) => index === 0
          ? { ...guard, routingOperationId }
          : guard),
      } as never)).toThrow("úplné assignment snapshoty");
    }
  });

  it("persists a released canonical seat guard so a later priority replacement can resume", () => {
    const operation = routingOperation();
    const freeSeatGuards = operation.assignmentGuards.map((guard) => guard.extension === "20"
      ? {
          ...guard,
          profileId: null,
          workplaceSeatGeneration: "abababab-abab-4bab-8bab-abababababab",
        }
      : guard);
    const persisted = {
      dispatchRouting: {
        revision: 2,
        currentPlan: operation.previousPlan,
        operation: { ...operation, assignmentGuards: freeSeatGuards },
      },
    };

    const parsed = parseDispatchRoutingState(persisted);
    expect(parsed.operation?.assignmentGuards.find((guard) => guard.extension === "20"))
      .toMatchObject({ profileId: null, workplaceSeatGeneration: "abababab-abab-4bab-8bab-abababababab" });
    expect(() => assertRoutingAssignmentGuardCoverage(parsed.operation as never)).not.toThrow();

    expect(() => parseDispatchRoutingState({
      dispatchRouting: {
        ...persisted.dispatchRouting,
        operation: {
          ...operation,
          assignmentGuards: freeSeatGuards.map((guard) => guard.extension === "20"
            ? { ...guard, workplaceSeatGeneration: undefined }
            : guard),
        },
      },
    })).toThrow("assignment interlocku");
  });

  it("uses updated_at compare-and-set and reports a concurrent metadata write as 409", async () => {
    const update = queryResult({ data: null, error: null });
    const client = sequentialClient([update]);
    await expect(compareAndSetDispatchRoutingState(client as never, rootQueue() as never, {
      revision: 3,
      currentPlan: { "601": "20", "602": "21", "603": "22" },
    })).rejects.toMatchObject({ status: 409 });
    expect(update.calls).toContainEqual({ method: "eq", args: ["updated_at", "2026-08-04T16:00:00.000Z"] });
  });

  it("allows an idle registered extension only in guarded self-service mode", () => {
    const fallback = routingOperation().fallback as DispatchRoutingFallback;
    const step = routingStep(0) as DispatchRoutingStep;
    const base = providerSnapshot();
    expect(() => validateDispatchControlledWindow({
      ...base,
      queueStatuses: base.queueStatuses.map((status) => status.queue === "601" ? { ...status, waitingCalls: 1 } : status),
    }, [step], fallback)).toThrow("čaká hovor");
    expect(() => validateDispatchControlledWindow({
      ...base,
      extensions: base.extensions.map((extension) => extension.extension === "20" ? { ...extension, isRegistered: true } : extension),
    }, [step], fallback)).toThrow("odregistrovaná");
    expect(() => validateDispatchControlledWindow({
      ...base,
      extensions: base.extensions.map((extension) => extension.extension === "20" ? { ...extension, isRegistered: true } : extension),
    }, [step], fallback, [], { allowRegisteredAffected: true })).not.toThrow();
    expect(() => validateDispatchControlledWindow({
      extensions: base.extensions.map((extension) => extension.extension === "20" ? { ...extension, isRegistered: true } : extension),
      queueStatuses: base.queueStatuses,
    }, [step], fallback, [], { allowRegisteredAffected: true })).toThrow("nevie overiť aktívne hovory");
    expect(() => validateDispatchControlledWindow({
      ...base,
      activeCalls: [{ direction: "outbound", status: "answered", callerExtension: "20", raw: {} }],
      extensions: base.extensions.map((extension) => extension.extension === "20" ? { ...extension, isRegistered: true } : extension),
    }, [step], fallback, [], { allowRegisteredAffected: true })).toThrow("aktívny hovor");
    expect(() => validateDispatchControlledWindow(base, [{ ...step, queue: "603", extension: "23" }], fallback))
      .toThrow("záloha nesmie byť súčasťou");
  });

  it("admits a registered make-before-break target anchor only in the guarded zero-call window", () => {
    const base = providerSnapshot();
    const step = routingStep(0) as DispatchRoutingStep;
    const fallback = { queue: "601", extension: "20" } as DispatchRoutingFallback;
    const ready = {
      ...base,
      extensions: base.extensions.map((extension) => extension.extension === "20"
        ? { ...extension, isRegistered: true }
        : extension),
    };
    const options = { allowRegisteredAffected: true, allowTargetAnchor: true };

    expect(() => validateDispatchControlledWindow(ready, [step], fallback, [], options)).not.toThrow();
    expect(() => validateDispatchControlledWindow(ready, [step], fallback, [], {
      allowRegisteredAffected: true,
    })).toThrow("záloha nesmie byť súčasťou");
    expect(() => validateDispatchControlledWindow({
      ...ready,
      queueStatuses: ready.queueStatuses.map((status) => status.queue === "601"
        ? { ...status, waitingCalls: 1 }
        : status),
    }, [step], fallback, [], options)).toThrow("čaká hovor");
    expect(() => validateDispatchControlledWindow({
      ...ready,
      queueStatuses: ready.queueStatuses.map((status) => status.queue === "601"
        ? { ...status, members: [{ extension: "20", paused: false, inUse: false, dynamic: true, callsTaken: 0 }] }
        : status),
    }, [step], fallback, [], options)).toThrow("bezpečnostná kotva");
  });

  it("requires exactly one provider extension row for every relevant and fallback extension", () => {
    const fallback = routingOperation().fallback as DispatchRoutingFallback;
    const step = routingStep(0) as DispatchRoutingStep;
    const base = providerSnapshot();

    expect(() => validateDispatchControlledWindow({
      ...base,
      extensions: base.extensions.filter((extension) => extension.extension !== "20"),
    }, [step], fallback, ["20", "23"])).toThrow("práve jeden aktuálny záznam klapky 20");

    expect(() => validateDispatchControlledWindow({
      ...base,
      extensions: [...base.extensions, { ...base.extensions[0] }],
    }, [step], fallback, ["20", "23"])).toThrow("duplicitný alebo konfliktný záznam klapky 20");
  });

  it("fails closed on missing, duplicate or unexpected queue statuses instead of assuming zero waiting calls", () => {
    const complete = providerSnapshot().queueStatuses;
    expect(() => assertCompleteDispatchQueueStatuses(complete)).not.toThrow();
    expect(() => assertCompleteDispatchQueueStatuses(complete.filter((status) => status.queue !== "603")))
      .toThrow("práve jeden aktuálny stav");
    expect(() => assertCompleteDispatchQueueStatuses([complete[0], complete[0], complete[2]]))
      .toThrow("práve jeden aktuálny stav");
    expect(() => assertCompleteDispatchQueueStatuses([...complete, { ...complete[0], queue: "999" }]))
      .toThrow("práve jeden aktuálny stav");

    const fallback = routingOperation().fallback as DispatchRoutingFallback;
    expect(() => validateDispatchControlledWindow({
      ...providerSnapshot(),
      queueStatuses: complete.slice(0, 2),
    }, [routingStep(0) as DispatchRoutingStep], fallback)).toThrow("neúplný alebo duplicitný snapshot");
  });

  it("detects pending queue work and blocks rollback on delivery uncertainty", () => {
    const pending = [
      { id: "old", request_payload: { queue: "601", extension: "20" } as Json },
      { id: "current", request_payload: { queue: "602", extension: "21" } as Json },
    ];
    expect(blockingDispatchQueueCommands(pending, "current").map((item) => item.id)).toEqual(["old"]);
    expect(hasUnresolvedDispatchDelivery([{
      request_payload: { routingOperation: { operationId } } as Json,
      provider_response: { deliveryUncertain: true } as Json,
    }], operationId)).toBe(true);
    expect(hasUnresolvedDispatchDelivery([{
      request_payload: { routingOperation: { operationId: "other" } } as Json,
      provider_response: { deliveryUncertain: true } as Json,
    }], operationId)).toBe(false);
  });

  it("enforces exact add/remove/pause/unpause observed membership preconditions", () => {
    const base = routingStep(0) as DispatchRoutingStep;
    const member = { extension: "20", paused: false, inUse: false, dynamic: true, callsTaken: 0 };
    const status = (members: typeof member[]) => [{ queue: "601", waitingCalls: 0, members }];
    expect(() => validateDispatchStepObservedState(status([]), { ...base, action: "add", commandType: "queue.add" })).not.toThrow();
    expect(() => validateDispatchStepObservedState(status([member]), { ...base, action: "remove", commandType: "queue.remove" })).not.toThrow();
    expect(() => validateDispatchStepObservedState(status([member]), { ...base, action: "pause", commandType: "queue.pause" })).not.toThrow();
    expect(() => validateDispatchStepObservedState(status([{ ...member, paused: true }]), { ...base, action: "unpause", commandType: "queue.unpause" })).not.toThrow();
    expect(() => validateDispatchStepObservedState(status([member]), { ...base, action: "add", commandType: "queue.add" })).toThrow("nezodpovedá");
    expect(() => validateDispatchStepObservedState(status([{ ...member, dynamic: false }]), { ...base, action: "remove", commandType: "queue.remove" })).toThrow("nezodpovedá");
  });
});

describe("empty dispatch bootstrap safety contracts", () => {
  it("is explicit and only starts from a completely empty stored plan", () => {
    expect(() => assertEmptyDispatchBootstrapState({
      revision: 0,
      currentPlan: { "601": null, "602": null, "603": null },
    })).not.toThrow();
    expect(() => assertEmptyDispatchBootstrapState({
      revision: 1,
      currentPlan: { "601": "20", "602": null, "603": null },
    })).toThrow("iba pred vytvorením prvého plánu");
    expect(() => assertEmptyDispatchBootstrapState({
      revision: 0,
      currentPlan: { "601": null, "602": null, "603": null },
      operation: bootstrapOperation(),
    })).toThrow("rozpracovanej routing operácie");
  });

  it("requires exact empty queues, registered targets, no live call and the last selected anchor", () => {
    const snapshot = emptyBootstrapSnapshot();
    const operation = bootstrapOperation();
    expect(() => validateEmptyDispatchBootstrapStart(snapshot, operation.targetPlan, operation.fallback)).not.toThrow();
    expect(() => validateEmptyDispatchBootstrapStart({
      ...snapshot,
      queueStatuses: withBootstrapMember(snapshot.queueStatuses, "603", "22"),
    }, operation.targetPlan, operation.fallback)).toThrow("úplne prázdne");
    expect(() => validateEmptyDispatchBootstrapStart({
      ...snapshot,
      extensions: snapshot.extensions.map((extension) => extension.extension === "21"
        ? { ...extension, isRegistered: false }
        : extension),
    }, operation.targetPlan, operation.fallback)).toThrow("Klapka 21");
    expect(() => validateEmptyDispatchBootstrapStart({
      ...snapshot,
      activeCalls: [{ direction: "inbound", status: "incoming", raw: {} }],
    }, operation.targetPlan, operation.fallback)).toThrow("bez aktívnych VIPTel hovorov");
    expect(() => validateEmptyDispatchBootstrapStart(snapshot, operation.targetPlan, {
      ...operation.fallback,
      queue: "601",
    })).toThrow("kotvu");
  });

  it("accepts only the exact reverse-priority prefix during apply", () => {
    const operation = bootstrapOperation();
    expect(operation.steps.map((step) => step.queue)).toEqual(["603", "602", "601"]);
    expect(() => validateEmptyDispatchBootstrapOperation(emptyBootstrapSnapshot(), operation)).not.toThrow();

    const afterAnchor = {
      ...operation,
      currentStep: 1,
      steps: operation.steps.map((step, index) => index === 0 ? { ...step, status: "confirmed" as const } : step),
    };
    expect(() => validateEmptyDispatchBootstrapOperation({
      ...emptyBootstrapSnapshot(),
      queueStatuses: withBootstrapMember(emptyBootstrapSnapshot().queueStatuses, "603", "22"),
    }, afterAnchor)).not.toThrow();
    expect(() => validateEmptyDispatchBootstrapOperation(emptyBootstrapSnapshot(), afterAnchor)).toThrow("presnému priebehu");

    expect(() => assertEmptyDispatchBootstrapOperationShape({
      ...operation,
      steps: [
        { ...operation.steps[1], stepIndex: 0 },
        { ...operation.steps[0], stepIndex: 1 },
        operation.steps[2],
      ],
    })).toThrow("neplatné poradie");
    expect(() => assertEmptyDispatchBootstrapOperationShape({
      ...operation,
      fallback: { ...operation.fallback, extension: "20", extensionId: bootstrapExtensionId("20") },
    })).toThrow("nezodpovedá poslednému obsadenému radu");
  });

  it("accepts a single registered first operator as a complete initial operation", () => {
    const operation = singleOperatorBootstrapOperation();
    expect(operation.steps.map((step) => step.queue)).toEqual(["601"]);
    expect(() => validateEmptyDispatchBootstrapStart(
      emptyBootstrapSnapshot(),
      operation.targetPlan,
      operation.fallback,
    )).not.toThrow();
    expect(() => validateEmptyDispatchBootstrapOperation(emptyBootstrapSnapshot(), operation)).not.toThrow();

    const completed = {
      ...operation,
      currentStep: 1,
      steps: operation.steps.map((step) => ({ ...step, status: "confirmed" as const })),
    };
    expect(() => validateEmptyDispatchBootstrapOperation({
      ...emptyBootstrapSnapshot(),
      queueStatuses: withBootstrapMember(emptyBootstrapSnapshot().queueStatuses, "601", "20"),
    }, completed)).not.toThrow();
  });

  it("keeps the 603 anchor until the last rollback step", () => {
    const operation = bootstrapRollbackOperation();
    const fullSnapshot = {
      ...emptyBootstrapSnapshot(),
      queueStatuses: [
        bootstrapQueueStatus("601", "20"),
        bootstrapQueueStatus("602", "21"),
        bootstrapQueueStatus("603", "22"),
      ],
    };
    expect(operation.steps.map((step) => step.queue)).toEqual(["601", "602", "603"]);
    expect(() => validateEmptyDispatchBootstrapOperation(fullSnapshot, operation)).not.toThrow();
    expect(() => assertEmptyDispatchBootstrapOperationShape({
      ...operation,
      steps: [
        { ...operation.steps[2], stepIndex: 0 },
        { ...operation.steps[0], stepIndex: 1 },
        { ...operation.steps[1], stepIndex: 2 },
      ],
    })).toThrow("neplatné poradie");
    expect(dispatchRecoveryIsRollingBack({ ...operation, status: "degraded" }, "resume")).toBe(true);
  });

  it("recovers only a planned partial state that still contains the 603 anchor", () => {
    const operation = bootstrapOperation();
    const anchored = {
      ...emptyBootstrapSnapshot(),
      queueStatuses: withBootstrapMember(emptyBootstrapSnapshot().queueStatuses, "603", "22"),
    };
    expect(() => validateEmptyDispatchBootstrapRecoverySnapshot(anchored, operation)).not.toThrow();
    expect(() => validateEmptyDispatchBootstrapRecoverySnapshot({
      ...emptyBootstrapSnapshot(),
      queueStatuses: withBootstrapMember(emptyBootstrapSnapshot().queueStatuses, "602", "21"),
    }, operation)).toThrow("stratil bezpečnostnú kotvu");
    const skippedSecondPriority = {
      ...emptyBootstrapSnapshot(),
      queueStatuses: withBootstrapMember(
        withBootstrapMember(emptyBootstrapSnapshot().queueStatuses, "603", "22"),
        "601",
        "20",
      ),
    };
    expect(() => validateEmptyDispatchBootstrapRecoverySnapshot(skippedSecondPriority, operation))
      .toThrow("presnému bezpečnému poradiu");
    expect(() => validateEmptyDispatchBootstrapRecoverySnapshot({
      ...anchored,
      queueStatuses: withBootstrapMember(anchored.queueStatuses, "601", "23"),
    }, operation)).toThrow("neočakávané alebo nedostupné členstvo");
  });

  it("recovers and rolls back a one-operator bootstrap without requiring queues 602 or 603", () => {
    const applying = singleOperatorBootstrapOperation();
    const withFirstOperator = {
      ...emptyBootstrapSnapshot(),
      queueStatuses: withBootstrapMember(emptyBootstrapSnapshot().queueStatuses, "601", "20"),
    };
    expect(() => validateEmptyDispatchBootstrapRecoverySnapshot(withFirstOperator, applying)).not.toThrow();

    const rollback = {
      ...applying,
      status: "rolling_back" as const,
      targetPlan: { "601": null, "602": null, "603": null },
      steps: [{
        ...applying.steps[0],
        commandType: "queue.remove" as const,
        action: "remove" as const,
      }],
    };
    expect(() => assertEmptyDispatchBootstrapOperationShape(rollback)).not.toThrow();
    expect(() => validateEmptyDispatchBootstrapOperation(withFirstOperator, rollback)).not.toThrow();
  });

  it("binds the reviewed digest to the explicit bootstrap mode", () => {
    const preview = {
      baseRevision: 0,
      targetRevision: 1,
      previousPlan: [
        { queue: "601" as const, extension: null },
        { queue: "602" as const, extension: null },
        { queue: "603" as const, extension: null },
      ],
      targetPlan: [
        { queue: "601" as const, extension: "20" },
        { queue: "602" as const, extension: "21" },
        { queue: "603" as const, extension: "22" },
      ],
      steps: bootstrapOperation().steps.map(({ stepIndex, action, queue, extension }) => ({ stepIndex, action, queue, extension })),
      fallback: { queue: "603" as const, extension: "22" },
    };
    expect(dispatchRoutingPreviewDigest({ ...preview, initialBootstrap: true })).not.toBe(dispatchRoutingPreviewDigest(preview));
  });
});

function rootQueue(options: { operation?: Record<string, unknown> | null } = {}) {
  const operation = options.operation === undefined ? routingOperation() : options.operation;
  return {
    id: "44444444-4444-4444-8444-444444444444",
    external_id: "601",
    line_id: null,
    updated_at: "2026-08-04T16:00:00.000Z",
    metadata: {
      dispatchRouting: {
        revision: 2,
        currentPlan: { "601": "20", "602": "21", "603": "22" },
        ...(operation ? { operation } : {}),
      },
    },
  };
}

function workplaceDraft(baseRevision: number) {
  return {
    schemaVersion: 1,
    baseRevision,
    selections: { "601": "20", "602": "21", "603": "22" },
    selectedBy: { "601": "profile-20", "602": "profile-21", "603": "profile-22" },
    updatedAt: "2026-08-05T12:00:00.000Z",
  };
}

function authorizedWorkplaceDraft(baseRevision: number, auditId: string) {
  return authorizeWorkplacePriorityDraft(
    workplaceDraft(baseRevision),
    { organizationId, rootQueueId: rootQueue().id },
    auditId,
    { SUPABASE_SECRET_KEY: workplaceServiceSecret },
  );
}

function workplaceDraftAuthorityRow(
  authorized: ReturnType<typeof authorizedWorkplaceDraft>,
  auditId: string,
) {
  return {
    id: auditId,
    action: "telephony.workplace.priority.draft",
    entity_id: rootQueue().id,
    after_payload: authorized.auditPayload,
    created_at: "2026-08-05T12:00:01.000Z",
  };
}

function bootstrapRootQueue() {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    external_id: "601",
    line_id: null,
    updated_at: "2026-08-05T00:00:00.000Z",
    metadata: {
      dispatchRouting: {
        revision: 0,
        currentPlan: { "601": null, "602": null, "603": null },
        operation: bootstrapListenerOperation(),
      },
    },
  };
}

function routingOperation() {
  return {
    operationId,
    status: "applying",
    baseRevision: 2,
    targetRevision: 3,
    previousPlan: { "601": "20", "602": "21", "603": "22" },
    targetPlan: { "601": "21", "602": "20", "603": "22" },
    steps: [routingStep(0), { ...routingStep(1), commandId: "55555555-5555-4555-8555-555555555555", stepIndex: 1, queue: "602" }],
    currentStep: 0,
    fallback: {
      queue: "603",
      extension: "23",
      queueId: "66666666-6666-4666-8666-666666666666",
      extensionId: "77777777-7777-4777-8777-777777777777",
    },
    affectedExtensions: ["20", "21"],
    assignmentGuards: routingAssignmentGuards(),
    actorProfileId: "88888888-8888-4888-8888-888888888888",
    createdAt: "2026-08-04T16:00:00.000Z",
    updatedAt: "2026-08-04T16:00:00.000Z",
  };
}

function foreignRoutingOperation() {
  const foreignOperationId = "abababab-abab-4bab-8bab-abababababab";
  const operation = routingOperation();
  return {
    ...operation,
    operationId: foreignOperationId,
    assignmentGuards: operation.assignmentGuards.map((guard) => ({
      ...guard,
      routingOperationId: foreignOperationId,
    })),
  };
}

function bootstrapOperation() {
  const targetPlan = { "601": "20", "602": "21", "603": "22" } as const;
  const queues = ["603", "602", "601"] as const;
  const extensions = { "601": "20", "602": "21", "603": "22" } as const;
  return {
    operationId,
    status: "applying" as const,
    baseRevision: 0,
    targetRevision: 1,
    previousPlan: { "601": null, "602": null, "603": null },
    targetPlan,
    steps: queues.map((queue, stepIndex) => ({
      stepIndex,
      commandId: `bootstrap-command-${queue}`,
      idempotencyKey: `bootstrap-idempotency-${queue}`,
      commandType: "queue.add" as const,
      action: "add" as const,
      queue,
      queueId: `bootstrap-queue-${queue}`,
      extension: extensions[queue],
      extensionId: bootstrapExtensionId(extensions[queue]),
      status: "pending" as const,
    })),
    currentStep: 0,
    fallback: {
      queue: "603" as const,
      extension: "22",
      queueId: "bootstrap-queue-603",
      extensionId: bootstrapExtensionId("22"),
    },
    affectedExtensions: ["22", "21", "20"],
    assignmentGuards: bootstrapAssignmentGuards(),
    actorProfileId: "88888888-8888-4888-8888-888888888888",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    initialBootstrap: true as const,
  };
}

function singleOperatorBootstrapOperation() {
  const operation = bootstrapOperation();
  const step = {
    ...operation.steps[2],
    stepIndex: 0,
  };
  return {
    ...operation,
    targetPlan: { "601": "20", "602": null, "603": null },
    steps: [step],
    fallback: {
      queue: "601" as const,
      extension: "20",
      queueId: "bootstrap-queue-601",
      extensionId: bootstrapExtensionId("20"),
    },
    affectedExtensions: ["20"],
    assignmentGuards: operation.assignmentGuards.filter((guard) => guard.extension === "20"),
  };
}

function bootstrapListenerOperation() {
  const operation = bootstrapOperation();
  return {
    ...operation,
    steps: operation.steps.map((step, index) => index === 0 ? { ...step, commandId } : step),
  };
}

function bootstrapRollbackOperation() {
  const applying = bootstrapOperation();
  const queues = ["601", "602", "603"] as const;
  const extensions = { "601": "20", "602": "21", "603": "22" } as const;
  return {
    ...applying,
    status: "rolling_back" as const,
    targetPlan: { "601": null, "602": null, "603": null },
    steps: queues.map((queue, stepIndex) => ({
      ...applying.steps[0],
      stepIndex,
      commandId: `bootstrap-rollback-command-${queue}`,
      idempotencyKey: `bootstrap-rollback-idempotency-${queue}`,
      commandType: "queue.remove" as const,
      action: "remove" as const,
      queue,
      queueId: `bootstrap-queue-${queue}`,
      extension: extensions[queue],
      extensionId: bootstrapExtensionId(extensions[queue]),
    })),
    affectedExtensions: ["20", "21", "22"],
  };
}

function bootstrapAssignmentGuards() {
  const profileIds = {
    "20": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb0",
    "21": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    "22": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  };
  return ["20", "21", "22"].map((extension) => ({
    claimId: `bootstrap-claim-${extension}`,
    extension,
    extensionId: bootstrapExtensionId(extension),
    generation: `bootstrap-generation-${extension}`,
    lifecycleEpoch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    profileId: profileIds[extension as keyof typeof profileIds],
    routingOperationId: operationId,
  }));
}

function bootstrapAssignmentGuardQueries() {
  return bootstrapAssignmentGuards().flatMap((guard) => [
    queryResult({
      data: {
        id: guard.extensionId,
        extension: guard.extension,
        profile_id: guard.profileId,
        active: true,
        metadata: {
          assignmentGeneration: guard.generation,
          assignmentLifecycle: assignmentLifecycleForGuard(guard),
          assignmentActionClaim: {
            action: "dispatch.routing.bootstrap_empty",
            claimId: guard.claimId,
            generation: guard.generation,
            lifecycleEpoch: guard.lifecycleEpoch,
            profileId: guard.profileId,
            routingOperationId: operationId,
          },
        },
      },
      error: null,
    }),
    ...immutableAssignmentQueries(guard),
  ]);
}

function bootstrapExtensionId(extension: string) {
  const ids: Record<string, string> = {
    "20": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "21": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "22": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  return ids[extension] ?? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
}

function emptyBootstrapSnapshot() {
  const queueStatuses: ViptelQueueStatus[] = (["601", "602", "603"] as const)
    .map((queue) => ({ queue, waitingCalls: 0, members: [] }));
  return {
    extensions: ["20", "21", "22"].map((extension) => ({
      extension,
      isRegistered: true,
      allowedChanges: [],
      raw: {},
    })),
    queueStatuses,
    activeCalls: [],
  };
}

function bootstrapQueueStatus(queue: "601" | "602" | "603", extension: string) {
  return {
    queue,
    waitingCalls: 0,
    members: [{ extension, paused: false, inUse: false, dynamic: true, callsTaken: 0 }],
  };
}

function withBootstrapMember(
  statuses: ReturnType<typeof emptyBootstrapSnapshot>["queueStatuses"],
  queue: "601" | "602" | "603",
  extension: string,
) {
  return statuses.map((status) => status.queue === queue ? bootstrapQueueStatus(queue, extension) : status);
}

function routingAssignmentGuards() {
  const extensionIds = {
    "20": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "21": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "22": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "23": "77777777-7777-4777-8777-777777777777",
  };
  return ["20", "21", "22", "23"].map((extension, index) => ({
    claimId: `claim-${extension}`,
    extension,
    extensionId: extensionIds[extension as keyof typeof extensionIds],
    generation: `generation-${extension}`,
    lifecycleEpoch: `dddddddd-dddd-4ddd-8ddd-ddddddddddd${index}`,
    profileId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index}`,
    routingOperationId: operationId,
  }));
}

function assignmentGuardQueries() {
  return routingAssignmentGuards().flatMap((guard) => [
    queryResult({
      data: {
        id: guard.extensionId,
        extension: guard.extension,
        profile_id: guard.profileId,
        active: true,
        metadata: {
          assignmentGeneration: guard.generation,
          assignmentLifecycle: assignmentLifecycleForGuard(guard),
          assignmentActionClaim: {
            action: "dispatch.routing.apply",
            claimId: guard.claimId,
            generation: guard.generation,
            lifecycleEpoch: guard.lifecycleEpoch,
            profileId: guard.profileId,
            routingOperationId: operationId,
          },
        },
      },
      error: null,
    }),
    ...immutableAssignmentQueries(guard),
  ]);
}

function routingStep(stepIndex: number) {
  return {
    stepIndex,
    commandId,
    idempotencyKey: "abcdef123456",
    commandType: "queue.add",
    action: "add",
    queue: "601",
    queueId: "99999999-9999-4999-8999-999999999999",
    extension: "20",
    extensionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "pending",
  };
}

function priorityPayload() {
  return {
    queue: "601",
    extension: "20",
    action: "add",
    routingOperation: {
      operationId,
      authorityDigest: dispatchRoutingOperationAuthorityDigest(organizationId, routingOperation() as never),
      revision: 3,
      stepIndex: 0,
      fallback: { queue: "603", extension: "23" },
    },
  };
}

function bootstrapPriorityPayload() {
  return {
    queue: "603",
    extension: "22",
    action: "add",
    routingOperation: {
      operationId,
      authorityDigest: dispatchRoutingOperationAuthorityDigest(organizationId, bootstrapListenerOperation() as never),
      revision: 1,
      stepIndex: 0,
      fallback: { queue: "603", extension: "22" },
      initialBootstrap: true,
    },
  };
}

function availabilityPayload() {
  return {
    queue: "601",
    extension: "20",
    action: "add",
    assignmentGuard: {
      claimId: "availability-claim-20",
      extension: "20",
      extensionId: availabilityExtensionId,
      generation: "availability-generation-20",
      lifecycleEpoch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      profileId: availabilityProfileId,
    },
    routingAvailability: {
      kind: "availability",
      queue: "601",
      extension: "20",
      revision: 2,
      intent: "available",
      planDigest: testCommittedPlanDigest(),
    },
  };
}

function availabilityAssignmentQuery() {
  const guard = availabilityGuard();
  return queryResult({
    data: {
      id: availabilityExtensionId,
      extension: "20",
      profile_id: availabilityProfileId,
      active: true,
      metadata: {
        assignmentGeneration: "availability-generation-20",
        assignmentLifecycle: assignmentLifecycleForGuard(guard),
        assignmentActionClaim: {
          action: "queue.availability",
          claimId: "availability-claim-20",
          generation: "availability-generation-20",
          lifecycleEpoch: guard.lifecycleEpoch,
          profileId: availabilityProfileId,
        },
      },
    },
    error: null,
  });
}

function availabilityAssignmentQueries() {
  const guard = availabilityGuard();
  return [availabilityAssignmentQuery(), ...immutableAssignmentQueries(guard)];
}

function availabilityGuard() {
  return {
    claimId: "availability-claim-20",
    extension: "20",
    extensionId: availabilityExtensionId,
    generation: "availability-generation-20",
    lifecycleEpoch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    profileId: availabilityProfileId,
  };
}

function assignmentLifecycleForGuard(guard: {
  extension: string;
  extensionId: string;
  lifecycleEpoch: string;
  profileId: string;
}) {
  return {
    schemaVersion: 1,
    epoch: guard.lifecycleEpoch,
    state: "assigned",
    extensionId: guard.extensionId,
    extension: guard.extension,
    profileId: guard.profileId,
    assignmentMode: "initial_provisioning",
    assignedAt: "2026-08-03T16:00:00.000Z",
    assignedBy: guard.profileId,
  };
}

function immutableAssignmentQueries(guard: {
  extension: string;
  extensionId: string;
  lifecycleEpoch: string;
  profileId: string;
}) {
  return [
    queryResult({
      data: {
        id: `assignment-audit-${guard.extension}`,
        action: "telephony.extension.assign",
        after_payload: { assignment_lifecycle: assignmentLifecycleForGuard(guard) },
        created_at: "2026-08-03T16:00:00.000Z",
      },
      error: null,
    }),
    queryResult({ data: { id: guard.profileId, phone_extension: guard.extension }, error: null }),
  ];
}

function priorityCommand(): TelephonyCommandRow {
  return {
    id: commandId,
    organization_id: organizationId,
    provider: "viptel",
    command_type: "queue.add",
    requested_by: null,
    call_id: null,
    queue_id: null,
    extension_id: null,
    request_payload: priorityPayload() as Json,
    provider_response: {},
    status: "sent",
    idempotency_key: "abcdef123456",
    created_at: "2026-08-04T16:00:00.000Z",
    updated_at: "2026-08-04T16:00:00.000Z",
    sent_at: "2026-08-04T16:00:00.000Z",
    confirmed_at: null,
  };
}

function exactRoutingFailureCommand(): TelephonyCommandRow {
  const operation = routingOperation();
  const step = operation.steps[operation.currentStep];
  return {
    ...priorityCommand(),
    command_type: step.commandType,
    extension_id: step.extensionId,
    id: step.commandId,
    idempotency_key: step.idempotencyKey,
    organization_id: organizationId,
    provider: "viptel",
    queue_id: step.queueId,
    request_payload: priorityPayload() as Json,
    requested_by: operation.actorProfileId,
  };
}

function availabilityCommand(): TelephonyCommandRow {
  return {
    ...priorityCommand(),
    extension_id: availabilityExtensionId,
    requested_by: availabilityProfileId,
    request_payload: availabilityPayload() as Json,
  };
}

function bootstrapPriorityCommand(): TelephonyCommandRow {
  return {
    ...priorityCommand(),
    request_payload: bootstrapPriorityPayload() as Json,
    command_type: "queue.add",
  };
}

function provider(options: {
  currentMember?: boolean;
  duplicateExtension?: string;
  duplicateMember?: { extension: string; queue: "601" | "602" | "603" };
  fallbackRegistered?: boolean;
  order?: string[];
  registeredExtensions?: string[];
  reportedQueue?: Partial<Record<"601" | "602" | "603", string>>;
} = {}) {
  const order = options.order ?? [];
  return {
    listActiveCalls: vi.fn(async () => {
      order.push("activeCalls");
      return [];
    }),
    listExtensions: vi.fn(async () => {
      order.push("extensions");
      const extensions = [
        { extension: "20", isRegistered: options.registeredExtensions?.includes("20") ?? false, allowedChanges: [], raw: {} },
        { extension: "21", isRegistered: options.registeredExtensions?.includes("21") ?? false, allowedChanges: [], raw: {} },
        { extension: "22", isRegistered: options.registeredExtensions?.includes("22") ?? false, allowedChanges: [], raw: {} },
        { extension: "23", isRegistered: options.fallbackRegistered ?? true, allowedChanges: [], raw: {} },
      ];
      const duplicate = extensions.find((extension) => extension.extension === options.duplicateExtension);
      return duplicate ? [...extensions, { ...duplicate }] : extensions;
    }),
    getQueueStatus: vi.fn(async (queue: string) => {
      order.push(queue);
      const members = queue === "603"
        ? [{ extension: "23", paused: false, inUse: false, dynamic: true, callsTaken: 0 }]
        : queue === "601" && options.currentMember
          ? [{ extension: "20", paused: false, inUse: false, dynamic: true, callsTaken: 0 }]
          : [];
      const duplicate = options.duplicateMember?.queue === queue
        ? members.find((member) => member.extension === options.duplicateMember?.extension)
        : undefined;
      return {
        queue: options.reportedQueue?.[queue as "601" | "602" | "603"] ?? queue,
        waitingCalls: 0,
        members: duplicate ? [...members, { ...duplicate }] : members,
      };
    }),
  };
}

function bootstrapListenerProvider(options: {
  activeCalls?: Array<{
    direction: "inbound" | "outbound" | "internal";
    status: "incoming" | "ringing_agent" | "answered" | "missed" | "abandoned_queue" | "outbound" | "ended" | "failed";
    raw: Record<string, unknown>;
  }>;
} = {}) {
  return {
    listExtensions: vi.fn(async () => emptyBootstrapSnapshot().extensions),
    listActiveCalls: vi.fn(async () => options.activeCalls ?? []),
    getQueueStatus: vi.fn(async (queue: string) => ({ queue, waitingCalls: 0, members: [] })),
  };
}

function providerSnapshot() {
  return {
    activeCalls: [],
    extensions: [
      { extension: "20", isRegistered: false, allowedChanges: [], raw: {} },
      { extension: "23", isRegistered: true, allowedChanges: [], raw: {} },
    ],
    queueStatuses: [
      { queue: "601", waitingCalls: 0, members: [] },
      { queue: "602", waitingCalls: 0, members: [] },
      { queue: "603", waitingCalls: 0, members: [{ extension: "23", paused: false, inUse: false, dynamic: true, callsTaken: 0 }] },
    ],
  };
}

type TestRoutingOperation = (
  ReturnType<typeof routingOperation> | ReturnType<typeof bootstrapListenerOperation>
) & {
  rootMetadataGuard?: { key: "workplacePriorityDraft"; digest: string; authorityId: string };
};

function routingValidationQueries(operation: TestRoutingOperation) {
  return [routingAuthorityQuery(operation), routingProgressQuery(operation)];
}

function routingAuthorityQuery(operation: TestRoutingOperation) {
  return queryResult({ data: [routingAuthorityRow(operation)], error: null });
}

function routingAuthorityRow(operation: TestRoutingOperation) {
  const intent = {
    schemaVersion: 1,
    organizationId,
    operationId: operation.operationId,
    actorProfileId: operation.actorProfileId,
    baseRevision: operation.baseRevision,
    targetRevision: operation.targetRevision,
    previousPlan: canonicalTestPlan(operation.previousPlan),
    targetPlan: canonicalTestPlan(operation.targetPlan),
    steps: operation.steps.map((step) => ({
      stepIndex: step.stepIndex,
      commandId: step.commandId,
      idempotencyKey: step.idempotencyKey,
      commandType: step.commandType,
      action: step.action,
      queue: step.queue,
      queueId: step.queueId,
      extension: step.extension,
      extensionId: step.extensionId,
    })),
    fallback: {
      queue: operation.fallback.queue,
      queueId: operation.fallback.queueId,
      extension: operation.fallback.extension,
      extensionId: operation.fallback.extensionId,
    },
    affectedExtensions: [...operation.affectedExtensions].sort(),
    assignmentGuards: [...operation.assignmentGuards]
      .sort((left, right) => left.extensionId.localeCompare(right.extensionId))
      .map((guard) => ({
        claimId: guard.claimId,
        extension: guard.extension,
        extensionId: guard.extensionId,
        generation: guard.generation,
        lifecycleEpoch: guard.lifecycleEpoch,
        profileId: guard.profileId,
        routingOperationId: guard.routingOperationId,
      })),
    ...(operation.rootMetadataGuard ? { rootMetadataGuard: operation.rootMetadataGuard } : {}),
    createdAt: operation.createdAt,
    initialBootstrap: "initialBootstrap" in operation && operation.initialBootstrap === true,
  };
  return {
    id: "routing-authority",
    action: "telephony.routing.operation.authorized",
    entity_id: operation.operationId,
    created_at: operation.createdAt,
    after_payload: {
      routing_operation_authority: {
        schemaVersion: 1,
        digest: dispatchRoutingOperationAuthorityDigest(organizationId, operation as never),
        intent,
      },
    },
  };
}

function routingProgressQuery(operation: TestRoutingOperation) {
  const confirmedCount = "releasePending" in operation && operation.releasePending
    ? operation.steps.length
    : operation.currentStep;
  const authorityDigest = dispatchRoutingOperationAuthorityDigest(organizationId, operation as never);
  return queryResult({
    data: operation.steps.slice(0, confirmedCount).map((step) => ({
      id: `routing-confirmation-${step.stepIndex}`,
      after_payload: {
        routing_step_confirmation: {
          schemaVersion: 1,
          authorityDigest,
          organizationId,
          operationId: operation.operationId,
          stepIndex: step.stepIndex,
          commandId: step.commandId,
          commandType: step.commandType,
          queue: step.queue,
          extension: step.extension,
        },
      },
    })),
    error: null,
  });
}

function committedPlanQuery(root: ReturnType<typeof rootQueue>) {
  return queryResult({ data: [committedPlanRow(root)], error: null });
}

function expectGlobalHeadQuery(query: ReturnType<typeof queryResult>) {
  expect(query.calls).toContainEqual({ method: "order", args: ["created_at", { ascending: false }] });
  expect(query.calls).toContainEqual({ method: "order", args: ["id", { ascending: false }] });
  expect(query.calls).toContainEqual({ method: "limit", args: [2] });
}

function committedPlanRow(root: ReturnType<typeof rootQueue>) {
  const state = (root.metadata as {
    dispatchRouting: { currentPlan: { "601": string; "602": string; "603": string }; revision: number };
  }).dispatchRouting;
  return {
    id: "routing-plan-commit",
    action: "telephony.routing.plan.committed",
    entity_id: root.id,
    created_at: "2026-08-04T15:59:00.000Z",
    after_payload: {
      routing_plan_commit: {
        schemaVersion: 1,
        organizationId,
        rootId: root.id,
        operationId,
        revision: state.revision,
        currentPlan: canonicalTestPlan(state.currentPlan),
        digest: dispatchRoutingCommittedPlanDigest(organizationId, root.id, state),
      },
    },
  };
}

function testCommittedPlanDigest() {
  const root = rootQueue({ operation: null });
  const state = (root.metadata as {
    dispatchRouting: { currentPlan: { "601": string; "602": string; "603": string }; revision: number };
  }).dispatchRouting;
  return dispatchRoutingCommittedPlanDigest(organizationId, root.id, state);
}

function canonicalTestPlan(plan: { "601": string | null; "602": string | null; "603": string | null }) {
  return { "601": plan["601"], "602": plan["602"], "603": plan["603"] };
}

function reverseObjectKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjectKeysDeep) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeysDeep(nested)]),
  ) as T;
}

function sequentialClient(results: ReturnType<typeof queryResult>[]) {
  let index = 0;
  return { from: vi.fn(() => results[index++].query) };
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
        if (property === "maybeSingle" || property === "single") return Promise.resolve(result);
        return query;
      };
    },
  });
  return { calls, query };
}
