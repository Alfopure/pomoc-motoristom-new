import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureGuards: vi.fn(),
  createAdmin: vi.fn(),
  requestSnapshot: vi.fn(),
  releaseGuards: vi.fn(),
  revalidateGuards: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.createAdmin }));
vi.mock("./provider-snapshot-bridge", () => ({ requestViptelProviderSnapshot: mocks.requestSnapshot }));
vi.mock("./assignment-interlock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assignment-interlock")>();
  return {
    ...actual,
    captureRoutingAssignmentGuards: mocks.captureGuards,
    releaseRoutingAssignmentGuards: mocks.releaseGuards,
    revalidateRoutingAssignmentGuards: mocks.revalidateGuards,
  };
});

import { AssignmentInterlockRejected } from "./assignment-interlock";
import {
  dispatchRoutingCommittedPlanDigest,
  dispatchRoutingOperationAuthorityDigest,
  dispatchRoutingPreviewDigest,
  dispatchRoutingRootMetadataDigest,
  previewOrStartDispatchRoutingPlan,
  recoverDispatchRoutingOperation,
  type DispatchRoutingOperation,
} from "./dispatch-routing";
import { authorizeWorkplacePriorityDraft } from "./workplace-draft-authority";

const actor = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
  role: "manager",
} as const;
const operationId = "33333333-3333-4333-8333-333333333333";
const currentCommandId = "44444444-4444-4444-8444-444444444444";
const workplaceAuthorityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workplaceServiceSecret = "test-workplace-authority-secret-at-least-32-characters";

describe("dispatch routing crash recovery", () => {
  beforeEach(() => {
    mocks.createAdmin.mockReset();
    mocks.requestSnapshot.mockReset();
    mocks.releaseGuards.mockReset();
    mocks.captureGuards.mockReset();
    mocks.revalidateGuards.mockReset();
    mocks.captureGuards.mockResolvedValue(assignmentGuards());
    mocks.releaseGuards.mockResolvedValue(undefined);
    mocks.revalidateGuards.mockResolvedValue(undefined);
    process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
    process.env.VIPTEL_LIVE_MUTATION_TOKEN = "a".repeat(32);
    process.env.SUPABASE_SECRET_KEY = workplaceServiceSecret;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    delete process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
    delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.VERCEL_ENV;
  });

  it("refuses to recover a different routing journal than the caller inspected", async () => {
    const operation = storedOperation("applying");
    const client = sequentialClient([
      queryResult({ data: queueCatalog(operation), error: null }),
    ]);
    mocks.createAdmin.mockReturnValue(client);

    await expect(recoverDispatchRoutingOperation(
      actor as never,
      "rollback",
      "99999999-9999-4999-8999-999999999999",
    )).rejects.toMatchObject({
      code: "routing_recovery_operation_changed",
      status: 409,
    });
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
  });

  it.each(["applying", "rolling_back"] as const)(
    "rebuilds and atomically enqueues a missing current step for a stranded %s operation",
    async (status) => {
      const operation = storedOperation(status);
      const authorizedDraft = authorizeTestWorkplaceDraft(operation.baseRevision, workplaceAuthorityId);
      const draft = authorizedDraft.draft;
      if (status === "applying") {
        operation.rootMetadataGuard = {
          key: "workplacePriorityDraft",
          digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", draft),
          authorityId: workplaceAuthorityId,
        };
      }
      const catalog = queueCatalog(operation);
      if (operation.rootMetadataGuard) {
        (catalog[0].metadata as Record<string, unknown>).workplacePriorityDraft = draft;
      }
      const currentMissing = queryResult({ data: null, error: null });
      const blocking = queryResult({ data: [], error: null });
      const uncertain = queryResult({ data: [], error: null });
      const extensionRows = queryResult({ data: extensions(), error: null });
      const cas = queryResult({ data: catalog[0], error: null });
      const authorizeRecovered = queryResult({ data: { id: "recovered-authority" }, error: null });
      const enqueue = queryResult({ data: null, error: null });
      const audit = queryResult({ data: null, error: null });
      const overviewQueues = queryResult({ data: catalog, error: null });
      const overviewExtensions = queryResult({ data: [], error: null });
      const overviewMemberships = queryResult({ data: [], error: null });
      const overviewSnapshots = queryResult({ data: [], error: null });
      const client = sequentialClient([
        queryResult({ data: catalog, error: null }),
        ...(operation.rootMetadataGuard
          ? [queryResult({ data: [workplaceDraftAuthorityRow(authorizedDraft, workplaceAuthorityId)], error: null })]
          : []),
        ...routingValidationQueries(operation),
        currentMissing,
        blocking,
        uncertain,
        extensionRows,
        cas,
        authorizeRecovered,
        deferredRoutingAuthority(cas),
        queryResult({ data: [], error: null }),
        enqueue,
        audit,
        overviewQueues,
        overviewExtensions,
        overviewMemberships,
        overviewSnapshots,
      ]);
      mocks.createAdmin.mockReturnValue(client);
      mocks.requestSnapshot.mockResolvedValue(providerSnapshotFor(status, {
        registeredAffected: Boolean(operation.rootMetadataGuard),
      }));

      await expect(recoverDispatchRoutingOperation(actor as never, "resume")).resolves.toMatchObject({
        revision: 2,
        operation: expect.objectContaining({ operationId }),
      });

      expect(currentMissing.calls).toContainEqual({ method: "eq", args: ["id", currentCommandId] });
      const stateWrite = cas.calls.find((call) => call.method === "update")?.args[0] as {
        metadata: { dispatchRouting: { operation: {
          rootMetadataGuard?: DispatchRoutingOperation["rootMetadataGuard"];
          status: string;
          steps: unknown[];
        } } };
      };
      expect(stateWrite.metadata.dispatchRouting.operation).toMatchObject({ status });
      if (status === "applying") {
        expect(stateWrite.metadata.dispatchRouting.operation).toMatchObject({
          rootMetadataGuard: operation.rootMetadataGuard,
        });
      }
      expect(stateWrite.metadata.dispatchRouting.operation.steps.length).toBeGreaterThan(0);
      const commandWrite = enqueue.calls.find((call) => call.method === "insert")?.args[0] as Record<string, unknown>;
      expect(commandWrite).toMatchObject({
        command_type: expect.stringMatching(/^queue\./),
        organization_id: actor.organizationId,
        provider: "viptel",
        status: "queued",
      });
      expect(mocks.requestSnapshot).toHaveBeenCalledOnce();
      expect(mocks.captureGuards).not.toHaveBeenCalled();
      expect(mocks.revalidateGuards).toHaveBeenCalledTimes(2);
    },
  );

  it("resumes the degraded one-operator bootstrap after JSONB reorders both authority intents", async () => {
    const operation = singleOperatorBootstrapOperation();
    const catalog = queueCatalog(operation);
    const currentMissing = queryResult({ data: null, error: null });
    const noPendingCommands = queryResult({ data: [], error: null });
    const noUncertainDelivery = queryResult({ data: [], error: null });
    const extensionRows = queryResult({ data: singleOperatorExtensions(operation), error: null });
    const cas = queryResult({ data: catalog[0], error: null });
    const authorizeRecovered = queryResult({ data: { id: "recovered-bootstrap-authority" }, error: null });
    const currentAuthority = jsonbRoutingAuthorityQuery(operation);
    const recoveredAuthority = deferredJsonbRoutingAuthority(cas);
    const overviewQueues = deferredOverviewQueues(cas, catalog);
    const enqueue = queryResult({ data: null, error: null });
    const audit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({ data: catalog, error: null }),
      currentAuthority,
      routingProgressQuery(operation),
      currentMissing,
      noPendingCommands,
      noUncertainDelivery,
      extensionRows,
      cas,
      authorizeRecovered,
      recoveredAuthority,
      queryResult({ data: [], error: null }),
      enqueue,
      audit,
      overviewQueues,
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
    ]);
    mocks.createAdmin.mockReturnValue(client);
    mocks.requestSnapshot.mockResolvedValue(singleOperatorProviderSnapshot());

    await expect(recoverDispatchRoutingOperation(actor as never, "resume")).resolves.toMatchObject({
      revision: 0,
      operation: expect.objectContaining({
        initialBootstrap: true,
        operationId,
        status: "applying",
      }),
    });

    const stateWrite = cas.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: { operation: DispatchRoutingOperation } };
    };
    expect(stateWrite.metadata.dispatchRouting.operation).toMatchObject({
      assignmentGuards: operation.assignmentGuards,
      initialBootstrap: true,
      previousPlan: { "601": null, "602": null, "603": null },
      status: "applying",
      targetPlan: { "601": "20", "602": null, "603": null },
    });
    expect(stateWrite.metadata.dispatchRouting.operation.steps).toEqual([
      expect.objectContaining({ action: "add", extension: "20", queue: "601", status: "pending" }),
    ]);
    expect(stateWrite.metadata.dispatchRouting.operation.steps[0]?.commandId).not.toBe(currentCommandId);
    expect(authorizeRecovered.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      action: "telephony.routing.operation.authorized",
      entity_id: operationId,
    });
    expect(enqueue.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      command_type: "queue.add",
      organization_id: actor.organizationId,
      provider: "viptel",
      status: "queued",
    });
    expect(mocks.requestSnapshot).toHaveBeenCalledOnce();
    expect(mocks.captureGuards).not.toHaveBeenCalled();
    expect(mocks.releaseGuards).not.toHaveBeenCalled();
    expect(mocks.revalidateGuards).toHaveBeenCalledTimes(2);
    for (const authority of [currentAuthority, recoveredAuthority]) {
      expect(authority.calls).toContainEqual({ method: "order", args: ["created_at", { ascending: false }] });
      expect(authority.calls).toContainEqual({ method: "order", args: ["id", { ascending: false }] });
      expect(authority.calls).toContainEqual({ method: "limit", args: [2] });
    }
  });

  it("recaptures stale routing claims for unchanged owners before recovering", async () => {
    const operation = storedOperation("applying");
    const catalog = queueCatalog(operation);
    const replacementGuards = assignmentGuards().map((guard) => ({ ...guard, claimId: `fresh-${guard.extension}` }));
    const cas = queryResult({ data: catalog[0], error: null });
    const authorizeRecovered = queryResult({ data: { id: "recovered-authority" }, error: null });
    const enqueue = queryResult({ data: null, error: null });
    const audit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({ data: catalog, error: null }),
      ...routingValidationQueries(operation),
      queryResult({ data: null, error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: extensions(), error: null }),
      cas,
      authorizeRecovered,
      deferredRoutingAuthority(cas),
      queryResult({ data: [], error: null }),
      enqueue,
      audit,
      queryResult({ data: catalog, error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
    ]);
    mocks.createAdmin.mockReturnValue(client);
    mocks.requestSnapshot.mockResolvedValue(providerSnapshotFor("applying"));
    mocks.revalidateGuards
      .mockRejectedValueOnce(new AssignmentInterlockRejected("stale claim"))
      .mockResolvedValueOnce(undefined);
    mocks.captureGuards.mockResolvedValueOnce(replacementGuards);

    await expect(recoverDispatchRoutingOperation(actor as never, "resume")).resolves.toBeDefined();

    expect(mocks.captureGuards).toHaveBeenCalledWith(
      client,
      actor.organizationId,
      expect.arrayContaining(replacementGuards.map((guard) => guard.extensionId)),
      "dispatch.routing.recover",
      operationId,
    );
    const stateWrite = cas.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: { operation: { assignmentGuards: typeof replacementGuards } } };
    };
    expect(stateWrite.metadata.dispatchRouting.operation.assignmentGuards).toEqual(replacementGuards);
  });

  it("recovers a confirmed current step without a duplicate provider event and clears a zero-step recovery", async () => {
    const operation = storedOperation("applying");
    const catalog = queueCatalog(operation);
    const confirmedCurrent = queryResult({
      data: {
        id: operation.steps[operation.currentStep].commandId,
        status: "confirmed_by_event",
        command_type: operation.steps[operation.currentStep].commandType,
        request_payload: {
          routingOperation: {
            operationId: operation.operationId,
            stepIndex: operation.currentStep,
          },
        },
      },
      error: null,
    });
    const releasePending = queryResult({ data: { ...catalog[0], updated_at: "2026-08-04T16:00:01.000Z" }, error: null });
    const completed = queryResult({ data: { ...catalog[0], updated_at: "2026-08-04T16:00:02.000Z" }, error: null });
    const authorizeRelease = queryResult({ data: { id: "release-authority" }, error: null });
    const committed = queryResult({ data: { id: "routing-plan-commit" }, error: null });
    const client = sequentialClient([
      queryResult({ data: catalog, error: null }),
      ...routingValidationQueries(operation),
      confirmedCurrent,
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: extensions(), error: null }),
      releasePending,
      authorizeRelease,
      queryResult({ data: [], error: null }),
      completed,
      committed,
      queryResult({ data: null, error: null }),
      queryResult({ data: catalog, error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
    ]);
    mocks.createAdmin.mockReturnValue(client);
    // The provider already reflects the apply target, so recovery has no
    // provider command to enqueue and must only finish durable cleanup.
    mocks.requestSnapshot.mockResolvedValue(providerSnapshotFor("rolling_back"));

    await expect(recoverDispatchRoutingOperation(actor as never, "resume")).resolves.toBeDefined();

    expect(confirmedCurrent.calls).toContainEqual({
      method: "eq",
      args: ["id", operation.steps[operation.currentStep].commandId],
    });
    expect(mocks.requestSnapshot).toHaveBeenCalledOnce();
    expect(mocks.releaseGuards).toHaveBeenCalledWith(client, actor.organizationId, assignmentGuards());
    const pendingWrite = releasePending.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: { operation: { currentStep: number; status: string; steps: unknown[] } } };
    };
    expect(pendingWrite.metadata.dispatchRouting.operation).toMatchObject({
      currentStep: 0,
      status: "degraded",
      steps: [],
    });
    const completedWrite = completed.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: Record<string, unknown> };
    };
    expect(completedWrite.metadata.dispatchRouting).not.toHaveProperty("operation");
  });

  it("rolls back a definitely failed one-operator change when VIPTel still matches the previous plan", async () => {
    const operation = failedSingleOperatorWorkplaceOperation();
    const authorizedDraft = authorizeWorkplacePriorityDraft(
      {
        schemaVersion: 1,
        baseRevision: operation.baseRevision,
        selections: operation.targetPlan,
        selectedBy: { "601": actor.profileId, "602": null, "603": null },
        updatedAt: "2026-08-07T19:40:00.000Z",
      },
      {
        organizationId: actor.organizationId,
        rootQueueId: queueCatalog(operation)[0].id,
      },
      workplaceAuthorityId,
      { SUPABASE_SECRET_KEY: workplaceServiceSecret },
    );
    operation.rootMetadataGuard = {
      key: "workplacePriorityDraft",
      digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", authorizedDraft.draft),
      authorityId: workplaceAuthorityId,
    };
    const catalog = queueCatalog(operation);
    (catalog[0].metadata as Record<string, unknown>).workplacePriorityDraft = authorizedDraft.draft;

    const currentFailed = queryResult({
      data: {
        id: operation.steps[0].commandId,
        status: "failed",
        command_type: operation.steps[0].commandType,
        request_payload: {
          queue: "601",
          extension: "21",
          action: "add",
          routingOperation: {
            operationId: operation.operationId,
            revision: operation.targetRevision,
            stepIndex: 0,
          },
        },
      },
      error: null,
    });
    const noBlockingCommands = queryResult({ data: [], error: null });
    const definitelyNotDelivered = queryResult({
      data: [{
        id: operation.steps[0].commandId,
        status: "failed",
        request_payload: { routingOperation: { operationId: operation.operationId } },
        provider_response: { deliveryUncertain: false },
      }],
      error: null,
    });
    const extensionRows = queryResult({ data: failedSingleOperatorExtensions(operation), error: null });
    const releasePending = queryResult({
      data: { ...catalog[0], updated_at: "2026-08-07T19:40:01.000Z" },
      error: null,
    });
    const authorizeRelease = queryResult({ data: { id: "failed-rollback-release-authority" }, error: null });
    const completedCatalog = queueCatalog(operation).map((queue) => queue.external_id === "601"
      ? {
          ...queue,
          metadata: {
            ...queue.metadata,
            workplacePriorityDraft: authorizedDraft.draft,
            dispatchRouting: {
              revision: operation.targetRevision,
              currentPlan: operation.previousPlan,
            },
          },
          updated_at: "2026-08-07T19:40:02.000Z",
        }
      : queue);
    const completed = queryResult({ data: completedCatalog[0], error: null });
    const committed = queryResult({ data: { id: "failed-rollback-plan-commit" }, error: null });
    const rollbackAudit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({ data: catalog, error: null }),
      queryResult({
        data: [workplaceDraftAuthorityRow(authorizedDraft, workplaceAuthorityId)],
        error: null,
      }),
      ...routingValidationQueries(operation),
      currentFailed,
      noBlockingCommands,
      definitelyNotDelivered,
      extensionRows,
      releasePending,
      authorizeRelease,
      queryResult({ data: [], error: null }),
      completed,
      committed,
      rollbackAudit,
      queryResult({ data: completedCatalog, error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
    ]);
    mocks.createAdmin.mockReturnValue(client);
    mocks.requestSnapshot.mockResolvedValue(failedSingleOperatorPreviousProviderSnapshot());

    await expect(recoverDispatchRoutingOperation(
      actor as never,
      "rollback",
      operation.operationId,
    )).resolves.toMatchObject({
      revision: operation.targetRevision,
      operation: null,
    });

    expect(mocks.requestSnapshot).toHaveBeenCalledOnce();
    expect(mocks.releaseGuards).toHaveBeenCalledWith(client, actor.organizationId, operation.assignmentGuards);
    expect(mocks.captureGuards).not.toHaveBeenCalled();
    const commandQueries = client.tableQueries
      .filter(({ table }) => table === "motorist_telephony_commands");
    expect(commandQueries).toHaveLength(3);
    expect(commandQueries
      .flatMap(({ result }) => result.calls.filter((call) => call.method === "insert")))
      .toEqual([]);
    expect(currentFailed.calls.some((call) => call.method === "insert")).toBe(false);
    expect(noBlockingCommands.calls.some((call) => call.method === "insert")).toBe(false);
    expect(definitelyNotDelivered.calls.some((call) => call.method === "insert")).toBe(false);
    const releaseWrite = releasePending.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: { operation: { releasePending?: boolean; steps: unknown[] } } };
    };
    expect(releaseWrite.metadata.dispatchRouting.operation).toMatchObject({
      releasePending: true,
      steps: [],
    });
    const completedWrite = completed.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: Record<string, unknown> };
    };
    expect(completedWrite.metadata.dispatchRouting).toEqual({
      revision: operation.targetRevision,
      currentPlan: operation.previousPlan,
    });
  });

  it("resumes a partially released durable cleanup without provider access or guard recapture", async () => {
    const operation = {
      ...storedOperation("applying"),
      status: "degraded" as const,
      releasePending: true,
      steps: storedOperation("applying").steps.map((step) => ({ ...step, status: "confirmed" as const })),
      lastError: "Dokončuje sa uvoľnenie assignment interlocku.",
    };
    const catalog = queueCatalog(operation);
    const rootRouting = (catalog[0].metadata as { dispatchRouting: Record<string, unknown> }).dispatchRouting;
    rootRouting.revision = operation.targetRevision;
    rootRouting.currentPlan = operation.targetPlan;
    const completedCatalog = queueCatalog(operation).map((queue) => queue.external_id === "601"
      ? {
          ...queue,
          metadata: {
            dispatchRouting: {
              revision: operation.targetRevision,
              currentPlan: operation.targetPlan,
            },
          },
        }
      : queue);
    const completed = queryResult({ data: completedCatalog[0], error: null });
    const committed = queryResult({ data: { id: "routing-plan-commit" }, error: null });
    const releaseAudit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({ data: catalog, error: null }),
      ...routingValidationQueries(operation),
      completed,
      committed,
      releaseAudit,
      queryResult({ data: completedCatalog, error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: [], error: null }),
    ]);
    mocks.createAdmin.mockReturnValue(client);

    await expect(recoverDispatchRoutingOperation(actor as never, "resume")).resolves.toMatchObject({ operation: null });

    expect(mocks.releaseGuards).toHaveBeenCalledWith(client, actor.organizationId, operation.assignmentGuards);
    expect(mocks.captureGuards).not.toHaveBeenCalled();
    expect(mocks.revalidateGuards).not.toHaveBeenCalled();
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
  });

  it.each(["status", "revision", "plan", "pending_step", "nonterminal_cursor", "guard_operation"] as const)(
    "refuses malformed release-pending recovery metadata (%s) before releasing guards",
    async (corruption) => {
      const base = storedOperation("applying");
      const operation: DispatchRoutingOperation = {
        ...base,
        status: "degraded",
        releasePending: true,
        steps: base.steps.map((step) => ({ ...step, status: "confirmed" })),
        currentStep: base.steps.length - 1,
      };
      const catalog = queueCatalog(operation);
      const routing = (catalog[0].metadata as {
        dispatchRouting: { revision: number; currentPlan: DispatchRoutingOperation["targetPlan"]; operation: DispatchRoutingOperation };
      }).dispatchRouting;
      routing.revision = operation.targetRevision;
      routing.currentPlan = operation.targetPlan;

      if (corruption === "status") routing.operation.status = "applying";
      if (corruption === "revision") routing.revision = operation.targetRevision - 1;
      if (corruption === "plan") routing.currentPlan = operation.previousPlan;
      if (corruption === "pending_step") routing.operation.steps[0].status = "pending";
      if (corruption === "guard_operation") {
        routing.operation.assignmentGuards[0].routingOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      }
      if (corruption === "nonterminal_cursor") {
        routing.operation.steps.push({
          ...routing.operation.steps[0],
          commandId: "55555555-5555-4555-8555-555555555556",
          idempotencyKey: "abcdef123457",
          stepIndex: 1,
        });
        routing.operation.currentStep = 0;
      }

      const client = sequentialClient([
        queryResult({ data: catalog, error: null }),
        ...routingValidationQueries(base),
      ]);
      mocks.createAdmin.mockReturnValue(client);

      await expect(recoverDispatchRoutingOperation(actor as never, "resume")).rejects.toMatchObject({ status: 409 });
      expect(mocks.releaseGuards).not.toHaveBeenCalled();
      expect(mocks.captureGuards).not.toHaveBeenCalled();
      expect(mocks.requestSnapshot).not.toHaveBeenCalled();
      expect(client.from.mock.calls.length).toBeLessThanOrEqual(3);
    },
  );

  it("blocks recovery before provider access while the exact current step is still nonterminal", async () => {
    const operation = storedOperation("applying");
    const catalog = queueCatalog(operation);
    const current = queryResult({
      data: {
        id: currentCommandId,
        status: "queued",
        command_type: "queue.add",
        request_payload: {
          queue: "601",
          extension: "21",
          action: "add",
          routingOperation: { operationId, revision: 3, stepIndex: 0 },
        },
      },
      error: null,
    });
    const client = sequentialClient([
      queryResult({ data: catalog, error: null }),
      ...routingValidationQueries(operation),
      current,
    ]);
    mocks.createAdmin.mockReturnValue(client);

    await expect(recoverDispatchRoutingOperation(actor as never, "resume")).rejects.toMatchObject({ status: 409 });
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(client.from).toHaveBeenCalledTimes(4);
  });

  it("keeps a regular zero-step plan recoverable when claim release fails after root CAS", async () => {
    const operation = storedOperation("applying");
    const catalog = queueCatalog(operation);
    delete (catalog[0].metadata as { dispatchRouting: { operation?: unknown } }).dispatchRouting.operation;
    const authorizedDraft = authorizeTestWorkplaceDraft(2, workplaceAuthorityId);
    const draft = authorizedDraft.draft;
    const rootMetadataGuard = {
      key: "workplacePriorityDraft" as const,
      digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", draft),
      authorityId: workplaceAuthorityId,
    };
    (catalog[0].metadata as Record<string, unknown>).workplacePriorityDraft = draft;
    const releasePending = queryResult({ data: { ...catalog[0], updated_at: "2026-08-04T16:00:01.000Z" }, error: null });
    const authorizeRelease = queryResult({ data: { id: "release-authority" }, error: null });
    const failureAudit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({ data: catalog, error: null }),
      queryResult({ data: [workplaceDraftAuthorityRow(authorizedDraft, workplaceAuthorityId)], error: null }),
      committedPlanQuery(catalog),
      queryResult({ data: extensions(), error: null }),
      queryResult({ data: [], error: null }),
      releasePending,
      authorizeRelease,
      queryResult({ data: [], error: null }),
      failureAudit,
    ]);
    mocks.createAdmin.mockReturnValue(client);
    mocks.requestSnapshot.mockResolvedValue(providerSnapshotFor("applying"));
    mocks.releaseGuards.mockRejectedValueOnce(new AssignmentInterlockRejected("release unavailable"));
    const slots = [
      { queue: "601" as const, extension: "20" },
      { queue: "602" as const, extension: "21" },
      { queue: "603" as const, extension: "22" },
    ];
    const previewDigest = dispatchRoutingPreviewDigest({
      baseRevision: 2,
      targetRevision: 3,
      previousPlan: slots,
      targetPlan: slots,
      steps: [],
      fallback: { queue: "603", extension: "23" },
      rootMetadataGuard,
    });

    await expect(previewOrStartDispatchRoutingPlan(actor as never, {
      baseRevision: 2,
      slots,
      fallback: { queue: "603", extension: "23" },
      previewDigest,
      dryRun: false,
      rootMetadataGuard,
    })).rejects.toThrow("release unavailable");

    const stateWrite = releasePending.calls.find((call) => call.method === "update")?.args[0] as {
      metadata: { dispatchRouting: { operation: {
        releasePending: boolean;
        rootMetadataGuard?: DispatchRoutingOperation["rootMetadataGuard"];
        status: string;
        steps: unknown[];
      } } };
    };
    expect(stateWrite.metadata.dispatchRouting.operation).toMatchObject({
      releasePending: true,
      rootMetadataGuard,
      status: "degraded",
      steps: [],
    });
    expect(JSON.stringify(stateWrite.metadata.dispatchRouting.operation)).not.toContain("profile-20");
    expect(failureAudit.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      action: "telephony.routing.operation.release_failed",
    });
    expect(client.from).toHaveBeenCalledTimes(9);
  });
});

function storedOperation(status: "applying" | "rolling_back"): DispatchRoutingOperation {
  const previousPlan = { "601": "20", "602": "21", "603": "22" };
  const applyTarget = { "601": "21", "602": "20", "603": "22" };
  const targetPlan = status === "rolling_back" ? previousPlan : applyTarget;
  return {
    operationId,
    status,
    baseRevision: 2,
    targetRevision: 3,
    previousPlan,
    targetPlan,
    steps: [{
      stepIndex: 0,
      commandId: currentCommandId,
      idempotencyKey: "abcdef123456",
      commandType: "queue.add",
      action: "add",
      queue: "601",
      queueId: "55555555-5555-4555-8555-555555555555",
      extension: "21",
      extensionId: "66666666-6666-4666-8666-666666666666",
      status: "pending",
    }],
    currentStep: 0,
    fallback: {
      queue: "603",
      extension: "23",
      queueId: "77777777-7777-4777-8777-777777777777",
      extensionId: "88888888-8888-4888-8888-888888888888",
    },
    affectedExtensions: ["20", "21"],
    assignmentGuards: assignmentGuards(),
    actorProfileId: actor.profileId,
    createdAt: "2026-08-04T16:00:00.000Z",
    updatedAt: "2026-08-04T16:00:00.000Z",
  };
}

function failedSingleOperatorWorkplaceOperation(): DispatchRoutingOperation {
  const queueId = "99999999-9999-4999-8999-999999999991";
  const extension20Id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const extension21Id = "66666666-6666-4666-8666-666666666666";
  return {
    operationId,
    status: "degraded",
    baseRevision: 1,
    targetRevision: 2,
    previousPlan: { "601": "20", "602": null, "603": null },
    targetPlan: { "601": "21", "602": null, "603": null },
    steps: [{
      stepIndex: 0,
      commandId: currentCommandId,
      idempotencyKey: "failed-before-provider-access",
      commandType: "queue.add",
      action: "add",
      queue: "601",
      queueId,
      extension: "21",
      extensionId: extension21Id,
      status: "pending",
    }],
    currentStep: 0,
    fallback: {
      queue: "601",
      extension: "21",
      queueId,
      extensionId: extension21Id,
    },
    affectedExtensions: ["20", "21"],
    assignmentGuards: [
      {
        claimId: "failed-routing-claim-20",
        extension: "20",
        extensionId: extension20Id,
        generation: "failed-routing-generation-20",
        lifecycleEpoch: "dddddddd-dddd-4ddd-8ddd-ddddddddddd0",
        profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb0",
        routingOperationId: operationId,
      },
      {
        claimId: "failed-routing-claim-21",
        extension: "21",
        extensionId: extension21Id,
        generation: "failed-routing-generation-21",
        lifecycleEpoch: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
        profileId: actor.profileId,
        routingOperationId: operationId,
      },
    ],
    actorProfileId: actor.profileId,
    createdAt: "2026-08-07T19:40:00.000Z",
    updatedAt: "2026-08-07T19:40:01.000Z",
    lastError: "Metadata assignment interlocku routing operácie sú poškodené.",
  };
}

function failedSingleOperatorExtensions(operation: DispatchRoutingOperation) {
  return operation.assignmentGuards.map((guard) => ({
    id: guard.extensionId,
    extension: guard.extension,
    profile_id: guard.profileId,
    active: true,
    is_registered: false,
    metadata: {
      assignmentGeneration: guard.generation,
      assignmentActionClaim: {
        claimId: guard.claimId,
        generation: guard.generation,
        profileId: guard.profileId,
        routingOperationId: operation.operationId,
      },
    },
    updated_at: "2026-08-07T19:40:01.000Z",
  }));
}

function failedSingleOperatorPreviousProviderSnapshot() {
  return {
    extensions: [
      { extension: "20", isRegistered: true, allowedChanges: [], raw: {} },
      { extension: "21", isRegistered: false, allowedChanges: [], raw: {} },
    ],
    activeCalls: [],
    queueStatuses: (["601", "602", "603"] as const).map((queue) => ({
      queue,
      waitingCalls: 0,
      members: queue === "601" ? [member("20")] : [],
    })),
  };
}

function singleOperatorBootstrapOperation(): DispatchRoutingOperation {
  const extensionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const profileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const guard = {
    claimId: "claim-20",
    extension: "20",
    extensionId,
    generation: "generation-20",
    lifecycleEpoch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    profileId,
    routingOperationId: operationId,
  };
  return {
    operationId,
    status: "degraded",
    baseRevision: 0,
    targetRevision: 1,
    previousPlan: { "601": null, "602": null, "603": null },
    targetPlan: { "601": "20", "602": null, "603": null },
    steps: [{
      stepIndex: 0,
      commandId: currentCommandId,
      idempotencyKey: "bootstrap-command-before-enqueue",
      commandType: "queue.add",
      action: "add",
      queue: "601",
      queueId: "99999999-9999-4999-8999-999999999991",
      extension: "20",
      extensionId,
      status: "pending",
    }],
    currentStep: 0,
    fallback: {
      queue: "601",
      extension: "20",
      queueId: "99999999-9999-4999-8999-999999999991",
      extensionId,
    },
    affectedExtensions: ["20"],
    assignmentGuards: [guard],
    actorProfileId: actor.profileId,
    createdAt: "2026-08-06T09:45:51.568Z",
    updatedAt: "2026-08-06T09:45:52.020Z",
    lastError: "Routing operácia nezodpovedá nemennej serverovej autorizácii.",
    initialBootstrap: true,
  };
}

function singleOperatorExtensions(operation: DispatchRoutingOperation) {
  return operation.assignmentGuards.map((guard) => ({
    id: guard.extensionId,
    extension: guard.extension,
    profile_id: guard.profileId,
    active: true,
    is_registered: true,
    metadata: {
      assignmentGeneration: guard.generation,
      assignmentActionClaim: {
        claimId: guard.claimId,
        generation: guard.generation,
        profileId: guard.profileId,
        routingOperationId: operation.operationId,
      },
    },
    updated_at: "2026-08-06T09:45:51.556Z",
  }));
}

function singleOperatorProviderSnapshot() {
  return {
    extensions: [{ extension: "20", isRegistered: true, allowedChanges: [], raw: {} }],
    activeCalls: [],
    queueStatuses: (["601", "602", "603"] as const).map((queue) => ({
      queue,
      waitingCalls: 0,
      members: [],
    })),
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

function authorizeTestWorkplaceDraft(baseRevision: number, auditId: string) {
  return authorizeWorkplacePriorityDraft(
    workplaceDraft(baseRevision),
    { organizationId: actor.organizationId, rootQueueId: queueCatalog(storedOperation("applying"))[0].id },
    auditId,
    { SUPABASE_SECRET_KEY: workplaceServiceSecret },
  );
}

function workplaceDraftAuthorityRow(
  authorized: ReturnType<typeof authorizeTestWorkplaceDraft>,
  auditId: string,
) {
  return {
    id: auditId,
    action: "telephony.workplace.priority.draft",
    entity_id: queueCatalog(storedOperation("applying"))[0].id,
    after_payload: authorized.auditPayload,
    created_at: "2026-08-05T12:00:01.000Z",
  };
}

function queueCatalog(operation: DispatchRoutingOperation) {
  return (["601", "602", "603"] as const).map((queue, index) => ({
    id: [`99999999-9999-4999-8999-999999999991`, `99999999-9999-4999-8999-999999999992`, `99999999-9999-4999-8999-999999999993`][index],
    organization_id: actor.organizationId,
    provider: "viptel",
    external_id: queue,
    label: queue === "601"
      ? "Dispečing – prvá priorita"
      : queue === "602"
        ? "Dispečing – druhá priorita"
        : "Dispečing – tretia priorita / slučka",
    line_id: null,
    active: true,
    metadata: queue === "601"
      ? { dispatchRouting: { revision: operation.baseRevision, currentPlan: operation.previousPlan, operation } }
      : {},
    updated_at: "2026-08-04T16:00:00.000Z",
  }));
}

function extensions() {
  return assignmentGuards().map((guard) => ({
    id: guard.extensionId,
    extension: guard.extension,
    profile_id: guard.profileId,
    active: true,
    is_registered: guard.extension === "23",
    metadata: {
      assignmentGeneration: guard.generation,
      assignmentActionClaim: {
        claimId: guard.claimId,
        generation: guard.generation,
        profileId: guard.profileId,
        routingOperationId: operationId,
      },
    },
    updated_at: "2026-08-04T16:00:00.000Z",
  }));
}

function assignmentGuards() {
  const extensionIds = {
    "20": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "21": "66666666-6666-4666-8666-666666666666",
    "22": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "23": "88888888-8888-4888-8888-888888888888",
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

function providerSnapshotFor(
  status: "applying" | "rolling_back",
  options: { registeredAffected?: boolean } = {},
) {
  const memberships = status === "applying"
    ? { "601": [member("20")], "602": [member("21")], "603": [member("22"), member("23")] }
    : { "601": [member("21")], "602": [member("20")], "603": [member("22"), member("23")] };
  return {
    extensions: [
      { extension: "20", isRegistered: options.registeredAffected ?? false, allowedChanges: [], raw: {} },
      { extension: "21", isRegistered: options.registeredAffected ?? false, allowedChanges: [], raw: {} },
      { extension: "22", isRegistered: false, allowedChanges: [], raw: {} },
      { extension: "23", isRegistered: true, allowedChanges: [], raw: {} },
    ],
    activeCalls: [],
    queueStatuses: (["601", "602", "603"] as const).map((queue) => ({
      queue: queue,
      waitingCalls: 0,
      members: memberships[queue],
    })),
  };
}

function member(extension: string) {
  return { extension, paused: false, inUse: false, dynamic: true, callsTaken: 0 };
}

function routingValidationQueries(operation: DispatchRoutingOperation) {
  return [routingAuthorityQuery(operation), routingProgressQuery(operation)];
}

function routingAuthorityQuery(operation: DispatchRoutingOperation) {
  return queryResult({ data: [routingAuthorityRow(operation)], error: null });
}

function jsonbRoutingAuthorityQuery(operation: DispatchRoutingOperation) {
  return queryResult({ data: [jsonbRoutingAuthorityRow(operation)], error: null });
}

function deferredRoutingAuthority(cas: ReturnType<typeof queryResult>) {
  return queryResult(() => {
    const update = cas.calls.find((call) => call.method === "update")?.args[0] as {
      metadata?: { dispatchRouting?: { operation?: DispatchRoutingOperation } };
    } | undefined;
    const operation = update?.metadata?.dispatchRouting?.operation;
    if (!operation) throw new Error("Recovered routing operation was not persisted before authority validation.");
    return { data: [routingAuthorityRow(operation)], error: null };
  });
}

function deferredJsonbRoutingAuthority(cas: ReturnType<typeof queryResult>) {
  return queryResult(() => {
    const update = cas.calls.find((call) => call.method === "update")?.args[0] as {
      metadata?: { dispatchRouting?: { operation?: DispatchRoutingOperation } };
    } | undefined;
    const operation = update?.metadata?.dispatchRouting?.operation;
    if (!operation) throw new Error("Recovered routing operation was not persisted before authority validation.");
    return { data: [jsonbRoutingAuthorityRow(operation)], error: null };
  });
}

function deferredOverviewQueues(
  cas: ReturnType<typeof queryResult>,
  catalog: ReturnType<typeof queueCatalog>,
) {
  return queryResult(() => {
    const update = cas.calls.find((call) => call.method === "update")?.args[0] as {
      metadata?: Record<string, unknown>;
    } | undefined;
    if (!update?.metadata) throw new Error("Recovered routing operation was not persisted before overview reload.");
    return {
      data: catalog.map((queue) => queue.external_id === "601"
        ? { ...queue, metadata: update.metadata }
        : queue),
      error: null,
    };
  });
}

function routingAuthorityRow(operation: DispatchRoutingOperation) {
  return {
    id: `routing-authority-${operation.operationId}`,
    action: "telephony.routing.operation.authorized",
    entity_id: operation.operationId,
    created_at: operation.createdAt,
    after_payload: {
      routing_operation_authority: {
        schemaVersion: 1,
        digest: dispatchRoutingOperationAuthorityDigest(actor.organizationId, operation),
        intent: routingIntent(operation),
      },
    },
  };
}

function jsonbRoutingAuthorityRow(operation: DispatchRoutingOperation) {
  const row = routingAuthorityRow(operation);
  const authority = row.after_payload.routing_operation_authority;
  row.after_payload.routing_operation_authority = {
    ...authority,
    intent: reverseObjectKeysDeep(authority.intent),
  };
  return row;
}

function routingProgressQuery(operation: DispatchRoutingOperation) {
  const confirmedCount = operation.releasePending ? operation.steps.length : operation.currentStep;
  const authorityDigest = dispatchRoutingOperationAuthorityDigest(actor.organizationId, operation);
  return queryResult({
    data: operation.steps.slice(0, confirmedCount).map((step) => ({
      id: `routing-confirmation-${step.stepIndex}`,
      after_payload: {
        routing_step_confirmation: {
          schemaVersion: 1,
          authorityDigest,
          organizationId: actor.organizationId,
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

function routingIntent(operation: DispatchRoutingOperation) {
  return {
    schemaVersion: 1,
    organizationId: actor.organizationId,
    operationId: operation.operationId,
    actorProfileId: operation.actorProfileId,
    baseRevision: operation.baseRevision,
    targetRevision: operation.targetRevision,
    previousPlan: canonicalPlan(operation.previousPlan),
    targetPlan: canonicalPlan(operation.targetPlan),
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
    initialBootstrap: Boolean(operation.initialBootstrap),
  };
}

function committedPlanQuery(catalog: ReturnType<typeof queueCatalog>) {
  const root = catalog[0];
  const state = (root.metadata as {
    dispatchRouting: { revision: number; currentPlan: DispatchRoutingOperation["previousPlan"] };
  }).dispatchRouting;
  return queryResult({
    data: [{
      id: "routing-plan-commit",
      action: "telephony.routing.plan.committed",
      entity_id: root.id,
      created_at: "2026-08-04T15:00:00.000Z",
      after_payload: {
        routing_plan_commit: {
          schemaVersion: 1,
          organizationId: actor.organizationId,
          rootId: root.id,
          operationId,
          revision: state.revision,
          currentPlan: canonicalPlan(state.currentPlan),
          digest: dispatchRoutingCommittedPlanDigest(actor.organizationId, root.id, state),
        },
      },
    }],
    error: null,
  });
}

function canonicalPlan(plan: DispatchRoutingOperation["previousPlan"]) {
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
  const tableQueries: Array<{ table: string; result: ReturnType<typeof queryResult> }> = [];
  return {
    from: vi.fn((table: string) => {
      const result = results[index++];
      tableQueries.push({ table, result });
      return result.query;
    }),
    tableQueries,
  };
}

function queryResult(result: { data: unknown; error: unknown } | (() => { data: unknown; error: unknown })) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          const current = typeof result === "function" ? result() : result;
          return Promise.resolve(current).then(resolve, reject);
        };
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        if (property === "maybeSingle" || property === "single") {
          return Promise.resolve(typeof result === "function" ? result() : result);
        }
        return query;
      };
    },
  });
  return { calls, query };
}
