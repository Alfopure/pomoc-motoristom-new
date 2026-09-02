import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const lifecycleMock = vi.hoisted(() => vi.fn(async (_client: unknown, _organizationId: string, extension: {
  metadata: { assignmentLifecycle?: unknown };
}) => extension.metadata.assignmentLifecycle));

vi.mock("server-only", () => ({}));
vi.mock("@/server/telephony/assignment-lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assignment-lifecycle")>();
  return { ...actual, requireImmutableWorkplaceSeatLifecycle: lifecycleMock };
});

import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  dispatchRoutingOperationAuthorityDigest,
  type DispatchRoutingOperation,
} from "./dispatch-routing";
import { workplaceSeatOwnershipVersion } from "./workplace-lease";
import { WorkplaceOperationRepositoryError } from "./workplace-operation-repository";
import type {
  BeginWorkplaceOperationInput,
  FinalizeWorkplaceOperationInput,
  MarkWorkplaceProviderCheckedInput,
  WorkplaceOperationRepository,
} from "./workplace-operation-repository";
import {
  cancelDynamicWorkplaceChange,
  confirmDynamicWorkplaceChange,
  definiteFailedWorkplaceRoutingCommand,
  leaveDynamicWorkplaceSeat,
  recoverAbandonedWorkplacePriorityDraft,
  recoverDefiniteFailedRoutingBeforeSeatSelection,
  selectDynamicWorkplaceSeat,
} from "./workplace-handoff";
import { authorizeWorkplacePriorityDraft } from "./workplace-draft-authority";

const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  organization: "33333333-3333-4333-8333-333333333333",
  browser: "44444444-4444-4444-8444-444444444444",
  otherBrowser: "55555555-5555-4555-8555-555555555555",
  evidence: "66666666-6666-4666-8666-666666666666",
  operation: "77777777-7777-4777-8777-777777777777",
  claim: "88888888-8888-4888-8888-888888888888",
  secondActor: "91919191-9191-4191-8191-919191919191",
  secondBrowser: "92929292-9292-4292-8292-929292929292",
  secondOperation: "93939393-9393-4393-8393-939393939393",
};
const resumeKey = "independent-test-resume-secret-key-0123456789";
const now = "2026-08-07T08:00:00.000Z";
const actor: MotoristActor = {
  userId: "99999999-9999-4999-8999-999999999999",
  organizationId: ids.organization,
  profileId: ids.actor,
  displayName: "Tester",
  role: "dispatcher",
};
const secondActor: MotoristActor = {
  userId: "94949494-9494-4494-8494-949494949494",
  organizationId: ids.organization,
  profileId: ids.secondActor,
  displayName: "Druhý tester",
  role: "dispatcher",
};

beforeEach(() => {
  lifecycleMock.mockClear();
  process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
  process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
  process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "trusted_test";
  process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "controlled_test";
  process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS = ids.actor;
  process.env.VIPTEL_WORKPLACE_QUEUE_CAPABILITY = "controlled_probe";
  process.env.VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID = ids.evidence;
  process.env.VIPTEL_WORKPLACE_QUEUE_PROBE_PROFILE_ID = ids.actor;
  process.env.VIPTEL_WORKPLACE_QUEUE_PROBE_SOURCE_EXTENSION = "20";
  process.env.VIPTEL_WORKPLACE_QUEUE_PROBE_STARTS_AT = "2026-08-07T07:30:00.000Z";
  process.env.VIPTEL_WORKPLACE_QUEUE_PROBE_ENDS_AT = "2026-08-07T09:30:00.000Z";
  process.env.VIPTEL_WORKPLACE_QUEUE_PROBE_FALLBACK_REFERENCE = "approved-test-fallback";
  process.env.VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER = "static_viptel";
  process.env.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS = "20,21,22,23";
  process.env.SUPABASE_SECRET_KEY = "test-workplace-authority-secret-at-least-32-characters";
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  for (const key of Object.keys(process.env).filter((key) => key.startsWith("VIPTEL_WORKPLACE_"))) {
    delete process.env[key];
  }
  delete process.env.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.VERCEL_ENV;
});

describe("dynamic workplace handoff", () => {
  it.each(["20", "21", "22", "23"])("claims free workplace %s with the same atomic lease contract", async (extension) => {
    const setup = harness({ extensions: seats() });

    const result = await selectDynamicWorkplaceSeat(actor, {
      extension,
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    expect(result).toMatchObject({
      result: { state: "confirmed" },
      lease: { extension, leaderEpoch: 1, leaseVersion: 1 },
      resumeSecret: expect.any(String),
    });
    expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({
      kind: "claim",
      sourceExtensionId: null,
      targetExtensionId: seatId(extension),
      resources: [
        { resource_type: "extension", resource_id: seatId(extension) },
        { resource_type: "profile", resource_id: ids.actor },
      ],
    }));
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("lets an arbitrary new dispatcher claim a free seat in the production static-SIP pilot", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "production_static_pilot";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "production";
    process.env.VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT = "I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT";
    process.env.VERCEL_ENV = "production";
    delete process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS;
    const setup = harness({ extensions: seats() });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "23" },
    });
    expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({ kind: "claim" }));
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it.each(["dispatcher", "senior_dispatcher", "manager", "admin"] as const)(
    "allows the same free-seat claim contract for the %s role",
    async (role) => {
      const setup = harness({ extensions: seats() });

      await expect(selectDynamicWorkplaceSeat({ ...actor, role }, {
        extension: "23",
        browserInstanceId: ids.browser,
        idempotencyKey: ids.operation,
      }, setup.dependencies)).resolves.toMatchObject({ lease: { extension: "23" } });

      expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({ kind: "claim" }));
    },
  );

  it("scopes a leave operation to the actor, source extension, and source lease", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
    });

    await expect(leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });

    const begin = setup.repository.begin.mock.calls[0]?.[0];
    expect(begin?.resources).toEqual([
      { resource_type: "extension", resource_id: seatId("20") },
      { resource_type: "profile", resource_id: ids.actor },
      { resource_type: "workplace_lease", resource_id: leaseId("20") },
    ]);
  });

  it("scopes a takeover to its target and both affected profiles without a routing-plan claim", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.other }),
      leases: [lease("20", ids.other, ids.otherBrowser, {
        expiresAt: "2026-08-07T07:59:59.000Z",
      })],
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ lease: { extension: "20" } });

    const begin = setup.repository.begin.mock.calls[0]?.[0];
    expect(begin).toMatchObject({ kind: "takeover" });
    expect(begin?.resources).toEqual([
      { resource_type: "extension", resource_id: seatId("20") },
      { resource_type: "profile", resource_id: ids.actor },
      { resource_type: "profile", resource_id: ids.other },
      { resource_type: "workplace_lease", resource_id: leaseId("20") },
    ]);
  });

  it("scopes a switch to both seats, leases, and affected profiles without a routing-plan claim", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor, "21": ids.other }),
      leases: [
        lease("20", ids.actor, ids.browser),
        lease("21", ids.other, ids.otherBrowser, {
          expiresAt: "2026-08-07T07:59:59.000Z",
        }),
      ],
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "21",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });

    const begin = setup.repository.begin.mock.calls[0]?.[0];
    expect(begin).toMatchObject({ kind: "switch" });
    expect(begin?.resources).toEqual([
      { resource_type: "extension", resource_id: seatId("20") },
      { resource_type: "extension", resource_id: seatId("21") },
      { resource_type: "profile", resource_id: ids.actor },
      { resource_type: "profile", resource_id: ids.other },
      { resource_type: "workplace_lease", resource_id: leaseId("20") },
      { resource_type: "workplace_lease", resource_id: leaseId("21") },
    ]);
  });

  it("lets two operators park independent leaves behind disjoint durable claims", async () => {
    enableProductionStaticPilot();
    const claims = new Map<string, string>();
    const first = harness({
      claimRegistry: claims,
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
    });
    const second = harness({
      claimRegistry: claims,
      extensions: seats({ "21": ids.secondActor }),
      leases: [lease("21", ids.secondActor, ids.secondBrowser)],
    });

    await expect(Promise.all([
      leaveDynamicWorkplaceSeat(actor, {
        browserInstanceId: ids.browser,
        idempotencyKey: ids.operation,
      }, first.dependencies),
      leaveDynamicWorkplaceSeat(secondActor, {
        browserInstanceId: ids.secondBrowser,
        idempotencyKey: ids.secondOperation,
      }, second.dependencies),
    ])).resolves.toEqual([
      expect.objectContaining({ result: expect.objectContaining({ state: "disconnect_required" }) }),
      expect.objectContaining({ result: expect.objectContaining({ state: "disconnect_required" }) }),
    ]);

    expect([...claims.values()].filter((operationId) => operationId === ids.operation)).toHaveLength(3);
    expect([...claims.values()].filter((operationId) => operationId === ids.secondOperation)).toHaveLength(3);
    expect(claims.size).toBe(6);
    expect(first.repository.abort).not.toHaveBeenCalled();
    expect(second.repository.abort).not.toHaveBeenCalled();
  });

  it("lets two operators park disjoint switches without blocking each other", async () => {
    enableProductionStaticPilot();
    const claims = new Map<string, string>();
    const first = harness({
      claimRegistry: claims,
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
    });
    const second = harness({
      claimRegistry: claims,
      extensions: seats({ "21": ids.secondActor }),
      leases: [lease("21", ids.secondActor, ids.secondBrowser)],
    });

    await expect(Promise.all([
      selectDynamicWorkplaceSeat(actor, {
        extension: "22",
        browserInstanceId: ids.browser,
        idempotencyKey: ids.operation,
      }, first.dependencies),
      selectDynamicWorkplaceSeat(secondActor, {
        extension: "23",
        browserInstanceId: ids.secondBrowser,
        idempotencyKey: ids.secondOperation,
      }, second.dependencies),
    ])).resolves.toEqual([
      expect.objectContaining({ result: expect.objectContaining({ state: "disconnect_required" }) }),
      expect.objectContaining({ result: expect.objectContaining({ state: "disconnect_required" }) }),
    ]);

    expect([...claims.values()].filter((operationId) => operationId === ids.operation)).toHaveLength(4);
    expect([...claims.values()].filter((operationId) => operationId === ids.secondOperation)).toHaveLength(4);
    expect(claims.size).toBe(8);
  });

  it("continues the exact committed begin after the RPC response is lost", async () => {
    const setup = harness({ beginMode: "commit_then_throw", extensions: seats() });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "23" },
      resumeSecret: expect.any(String),
    });

    expect(setup.repository.begin).toHaveBeenCalledOnce();
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("returns the exact terminal lease when a concurrent replay completes before finish", async () => {
    const setup = harness({
      extensions: seats(),
      operations: [operationRow()],
      completeOperationOnSecondRead: true,
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed", noOp: true },
      lease: { extension: "23" },
      resumeSecret: expect.any(String),
    });

    expect(setup.repository.finalize).not.toHaveBeenCalled();
    expect(setup.provider).not.toHaveBeenCalled();
  });

  it("safely reclaims the same seat after a tab closes and its lease expires", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.otherBrowser, {
        expiresAt: "2026-08-07T07:59:59.000Z",
      })],
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "20" },
      resumeSecret: expect.any(String),
    });

    expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({
      kind: "browser_transfer",
      sourceExtensionId: null,
      targetExtensionId: seatId("20"),
      targetLeaseId: leaseId("20"),
      browserInstanceId: ids.browser,
      resources: [
        { resource_type: "extension", resource_id: seatId("20") },
        { resource_type: "profile", resource_id: ids.actor },
        { resource_type: "workplace_lease", resource_id: leaseId("20") },
      ],
    }));
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("reclaims an expired same-user seat even when a crashed tab left a stale registrar contact", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.otherBrowser, {
        expiresAt: "2026-08-07T07:59:59.000Z",
      })],
      providerState: { registered: true },
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "20" },
    });

    expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({ kind: "browser_transfer" }));
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("takes an expired occupied seat with stale registration but still blocks a live call", async () => {
    const staleSeat = {
      extensions: seats({ "20": ids.other }),
      leases: [lease("20", ids.other, ids.otherBrowser, {
        expiresAt: "2026-08-07T07:59:59.000Z",
      })],
    };
    const allowed = harness({ ...staleSeat, providerState: { registered: true } });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, allowed.dependencies)).resolves.toMatchObject({ lease: { extension: "20" } });
    expect(allowed.repository.begin).toHaveBeenCalledWith(expect.objectContaining({ kind: "takeover" }));

    const blocked = harness({ ...staleSeat, providerState: { registered: true, activeCall: true } });
    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, blocked.dependencies)).rejects.toMatchObject({ status: 409 });
    expect(blocked.repository.finalize).not.toHaveBeenCalled();
  });

  it("abandons a definitely failed offline routing journal before taking its expired seat", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.other }),
      leases: [lease("20", ids.other, ids.otherBrowser, {
        expiresAt: "2026-08-07T07:59:59.000Z",
      })],
      providerState: { registered: false },
      routingOperationActive: true,
      recoverBlockingRoutingState: "recovered",
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "20" },
    });

    expect(setup.recoverBlockingRouting).toHaveBeenCalledWith(actor, "20");
    expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({ kind: "takeover" }));
    expect(setup.recoverBlockingRouting.mock.invocationCallOrder[0])
      .toBeLessThan(setup.repository.begin.mock.invocationCallOrder[0] as number);
  });

  it("does not begin a workplace takeover while routing rollback still has provider steps", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.other }),
      leases: [lease("20", ids.other, ids.otherBrowser, {
        expiresAt: "2026-08-07T07:59:59.000Z",
      })],
      routingOperationActive: true,
      recoverBlockingRoutingState: "pending",
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({
      code: "priority_recovery_pending",
      status: 423,
    });
    expect(setup.repository.begin).not.toHaveBeenCalled();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });

  it("rolls back the exact failed non-delivered routing command only after its owner lease expires", async () => {
    const fixture = failedRoutingRecoveryFixture();
    const recoverRouting = vi.fn(async () => ({ operation: null }));
    const expiredClient = routingRecoveryClient(fixture.root, fixture.command, [
      lease("21", ids.other, ids.otherBrowser, { expiresAt: "2026-08-07T07:59:59.000Z" }),
    ]);

    await expect(recoverDefiniteFailedRoutingBeforeSeatSelection(actor, "21", {
      client: expiredClient as never,
      repository: { databaseNow: vi.fn(async () => now) } as never,
      recoverRouting: recoverRouting as never,
    })).resolves.toBe("recovered");
    expect(recoverRouting).toHaveBeenCalledWith(actor, "rollback", fixture.operation.operationId);

    recoverRouting.mockClear();
    const freshClient = routingRecoveryClient(fixture.root, fixture.command, [
      lease("21", ids.other, ids.otherBrowser, { expiresAt: now }),
    ]);
    await expect(recoverDefiniteFailedRoutingBeforeSeatSelection(actor, "21", {
      client: freshClient as never,
      repository: { databaseNow: vi.fn(async () => now) } as never,
      recoverRouting: recoverRouting as never,
    })).resolves.toBe("none");
    expect(recoverRouting).not.toHaveBeenCalled();
  });

  it("fails closed for uncertain, mismatched, reconciled-applied, and nonterminal routing commands", () => {
    const baseline = failedRoutingRecoveryFixture();
    expect(definiteFailedWorkplaceRoutingCommand(
      ids.organization,
      baseline.operation,
      baseline.command as never,
    )).toBe(true);

    const cases = [
      { name: "uncertain", mutate: (value: ReturnType<typeof failedRoutingRecoveryFixture>) => {
        value.command.provider_response = { deliveryUncertain: true };
      } },
      { name: "missing proof", mutate: (value: ReturnType<typeof failedRoutingRecoveryFixture>) => {
        value.command.provider_response = {};
      } },
      { name: "already applied by reconciliation", mutate: (value: ReturnType<typeof failedRoutingRecoveryFixture>) => {
        value.command.provider_response = {
          deliveryUncertain: false,
          reconciledActual: { applied: true, queue: "601", extension: "21" },
        };
      } },
      { name: "malformed reconciliation", mutate: (value: ReturnType<typeof failedRoutingRecoveryFixture>) => {
        value.command.provider_response = { deliveryUncertain: false, reconciledActual: "not-an-object" };
      } },
      { name: "different reconciliation target", mutate: (value: ReturnType<typeof failedRoutingRecoveryFixture>) => {
        value.command.provider_response = {
          deliveryUncertain: false,
          reconciledActual: { applied: false, queue: "602", extension: "21" },
        };
      } },
      { name: "different command", mutate: (value: ReturnType<typeof failedRoutingRecoveryFixture>) => {
        value.command.id = "abababab-abab-4bab-8bab-abababababab";
      } },
      { name: "accepted", mutate: (value: ReturnType<typeof failedRoutingRecoveryFixture>) => {
        value.command.status = "accepted";
      } },
      { name: "already rolling back", mutate: (value: ReturnType<typeof failedRoutingRecoveryFixture>) => {
        value.operation.status = "rolling_back";
      } },
    ];
    for (const scenario of cases) {
      const value = failedRoutingRecoveryFixture();
      scenario.mutate(value);
      expect(
        definiteFailedWorkplaceRoutingCommand(ids.organization, value.operation, value.command as never),
        scenario.name,
      ).toBe(false);
    }

    const reconciledNotApplied = failedRoutingRecoveryFixture();
    reconciledNotApplied.command.provider_response = {
      deliveryUncertain: false,
      reconciledActual: { applied: false, queue: "601", extension: "21" },
    };
    expect(definiteFailedWorkplaceRoutingCommand(
      ids.organization,
      reconciledNotApplied.operation,
      reconciledNotApplied.command as never,
    )).toBe(true);
  });

  it("requires reclaim-then-switch when the actor's source lease expired in another browser", async () => {
    const reclaimOperation = "71717171-7171-4171-8171-717171717171";
    const switchOperation = "72727272-7272-4272-8272-727272727272";
    const setup = harness({
      extensions: seats({ "20": ids.actor, "21": ids.other }),
      finalizeMode: "commit_then_throw",
      leases: [
        lease("20", ids.actor, ids.otherBrowser, { expiresAt: "2026-08-07T07:59:59.000Z" }),
        lease("21", ids.other, ids.otherBrowser, { expiresAt: "2026-08-07T07:59:59.000Z" }),
      ],
    });

    // A new tab must not silently treat an old browser's source lease as its
    // own. The source fence is recovered first through browser_transfer.
    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "21",
      browserInstanceId: ids.browser,
      idempotencyKey: switchOperation,
    }, setup.dependencies)).rejects.toMatchObject({ code: "lease_lost", status: 409 });
    expect(setup.repository.begin).not.toHaveBeenCalled();

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: reclaimOperation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "20" },
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "21",
      browserInstanceId: ids.browser,
      idempotencyKey: switchOperation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "disconnect_required", operationId: switchOperation },
    });

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: switchOperation,
      operationId: switchOperation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "21" },
    });

    expect(setup.repository.begin).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "browser_transfer",
      sourceExtensionId: null,
      targetExtensionId: seatId("20"),
      targetLeaseId: leaseId("20"),
      browserInstanceId: ids.browser,
    }));
    expect(setup.repository.begin).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "switch",
      sourceExtensionId: seatId("20"),
      targetExtensionId: seatId("21"),
      targetLeaseId: leaseId("21"),
      browserInstanceId: ids.browser,
    }));
    expect(setup.repository.finalize).toHaveBeenCalledTimes(2);
  });

  it("marks an exact replay terminal after provider proof safely aborted precommit", async () => {
    const setup = harness({ extensions: seats(), providerState: { omitEndpoint: true } });
    const request = {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    };

    // The very first response already carries the definite-abort code. A
    // codeless failure here answered as a bare 5xx, which the client had to
    // treat as a possibly-committed lost response -- it armed the exact-replay
    // journal for a rolled-back request and blocked every other workplace
    // action while it spun.
    await expect(selectDynamicWorkplaceSeat(actor, request, setup.dependencies)).rejects.toMatchObject({
      code: "workplace_precommit_aborted",
    });
    await expect(selectDynamicWorkplaceSeat(actor, request, setup.dependencies)).rejects.toMatchObject({
      code: "workplace_precommit_aborted",
      status: 409,
    });
    expect(setup.repository.begin).toHaveBeenCalledOnce();
  });

  it("keeps the provider-snapshot refusal code and status on an aborted precommit", async () => {
    // The 2026-09-02 incident: VIPTel REST timed out, the snapshot bridge
    // answered 504 provider_snapshot_unavailable, the leave aborted safely --
    // and the operator was stuck, unable to leave or go available, because the
    // rethrown 504 had no code. The refusal must reach the client verbatim so
    // it can both stop replaying and offer the degraded leave.
    const setup = harness({ extensions: seats(), leases: [lease("20", ids.actor, ids.browser)] });
    setup.provider.mockRejectedValue(
      new MutationError("Hetzner listener nevrátil VIPTel snapshot v bezpečnom časovom limite.", 504, "provider_snapshot_unavailable"),
    );

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({
      code: "provider_snapshot_unavailable",
      status: 504,
    });
    expect(setup.repository.abort).toHaveBeenCalledOnce();
  });

  it("drains safely: blocks a new claim but continues an exact operation and own leave", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "false";
    delete process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS;

    const blocked = harness({ extensions: seats() });
    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, blocked.dependencies)).rejects.toMatchObject({ code: "hotdesk_claims_disabled", status: 503 });
    expect(blocked.repository.begin).not.toHaveBeenCalled();

    const replay = harness({
      extensions: seats(),
      operations: [operationRow({
        kind: "claim",
        target_extension_id: seatId("23"),
        browser_instance_id: ids.browser,
      })],
    });
    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, replay.dependencies)).resolves.toMatchObject({ result: { state: "confirmed" } });
    expect(replay.repository.begin).not.toHaveBeenCalled();

    const leaving = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
    });
    await expect(leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, leaving.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });
  });

  it("rejects a stale rendered seat version before reserving any resource", async () => {
    const setup = harness({ extensions: seats() });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      expectedVersion: "a".repeat(64),
      idempotencyKey: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({ code: "workplace_conflict", status: 409 });

    expect(setup.repository.begin).not.toHaveBeenCalled();
    expect(setup.provider).not.toHaveBeenCalled();
  });

  it("keeps the rendered ownership version stable across an ordinary heartbeat renewal", async () => {
    const renderedLease = lease("23", ids.other, ids.otherBrowser, {
      expiresAt: "2026-08-07T07:59:59.000Z",
    });
    const expectedVersion = workplaceSeatOwnershipVersion({
      seatId: seatId("23"),
      lifecycleEpoch: generationId("23"),
      lease: {
        id: renderedLease.id,
        assignmentGeneration: renderedLease.assignment_generation,
        state: renderedLease.state,
      },
    });
    const setup = harness({
      extensions: seats({ "23": ids.other }),
      leases: [lease("23", ids.other, ids.otherBrowser, {
        expiresAt: "2026-08-07T07:59:59.748828+00:00",
        heartbeatAt: "2026-08-07T07:59:30.748828+00:00",
        leaseVersion: 7,
      })],
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      expectedVersion,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ lease: { extension: "23" } });

    expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({
      expectedTargetLeaseVersion: 7,
      expectedTargetHeartbeatAt: "2026-08-07T07:59:30.748828+00:00",
    }));
  });

  it("parks a switch behind explicit browser disconnect and replays the original click without committing", async () => {
    const sourceLease = lease("20", ids.actor, ids.browser, {
      heartbeatAt: "2026-08-07T07:59:30.123456+00:00",
      expiresAt: "2026-08-07T08:00:30.123456+00:00",
    });
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [sourceLease],
    });
    const input = { extension: "23", browserInstanceId: ids.browser, idempotencyKey: ids.operation };

    await expect(selectDynamicWorkplaceSeat(actor, input, setup.dependencies)).resolves.toMatchObject({
      result: { state: "disconnect_required", operationId: ids.operation },
    });
    await expect(selectDynamicWorkplaceSeat(actor, input, setup.dependencies)).resolves.toMatchObject({
      result: { state: "disconnect_required", operationId: ids.operation },
    });

    expect(setup.provider).not.toHaveBeenCalled();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
    expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({
      expectedSourceHeartbeatAt: "2026-08-07T07:59:30.123456+00:00",
    }));

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "23" },
    });
    expect(setup.provider).toHaveBeenCalledOnce();
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("switches away from a disconnected source onto an expired target with a stale registrar contact", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor, "21": ids.other }),
      leases: [
        lease("20", ids.actor, ids.browser),
        lease("21", ids.other, ids.otherBrowser, { expiresAt: "2026-08-07T07:59:59.000Z" }),
      ],
      providerState: { registered: true, registeredExtension: "21" },
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "21",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ lease: { extension: "21" } });
    expect(setup.provider).toHaveBeenCalledOnce();
    expect(setup.sleep).not.toHaveBeenCalled();
  });

  it("leaves even when this is the only operator in priority 601, but only after disconnect confirmation", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
    });

    await expect(leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toEqual({
      result: { state: "confirmed", message: "Pracovné miesto je uvoľnené." },
    });
    expect(setup.repository.finalize).toHaveBeenCalledWith(expect.objectContaining({
      newLeaseId: null,
      targetLifecycle: null,
    }));
  });

  it("waits for VIPTel to observe the source unregister before completing a confirmed leave", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      providerStates: [{ registered: false }],
    });

    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toEqual({
      result: { state: "confirmed", message: "Pracovné miesto je uvoľnené." },
    });

    expect(setup.provider).toHaveBeenCalledOnce();
    expect(setup.sleep).not.toHaveBeenCalled();
    expect(setup.repository.abort).not.toHaveBeenCalled();
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("keeps the exact precommit operation retryable when only source unregister convergence is pending", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      providerStates: [{ registered: true }],
    });

    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({
      code: "workplace_source_unregister_pending",
      status: 423,
    });

    expect(setup.provider).toHaveBeenCalledOnce();
    expect(setup.sleep).not.toHaveBeenCalled();
    expect(setup.repository.markProviderChecked).not.toHaveBeenCalled();
    expect(setup.repository.abort).not.toHaveBeenCalled();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });

  it("completes the same confirm operation once a later fresh proof observes source unregistered", async () => {
    const extensionRows = seats({ "20": ids.actor });
    const setup = harness({
      extensions: extensionRows,
      leases: [lease("20", ids.actor, ids.browser)],
      providerStates: [
        { registered: true },
        { registered: false },
      ],
    });

    await selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);
    const confirmInput = {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    };

    await expect(confirmDynamicWorkplaceChange(actor, confirmInput, setup.dependencies)).rejects.toMatchObject({
      code: "workplace_source_unregister_pending",
      status: 423,
    });
    expect(setup.repository.abort).not.toHaveBeenCalled();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
    expect(extensionRows.find((extension) => extension.extension === "23")?.profile_id).toBeNull();

    await expect(confirmDynamicWorkplaceChange(actor, confirmInput, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "23" },
    });

    expect(setup.provider).toHaveBeenCalledTimes(2);
    expect(setup.repository.markProviderChecked).toHaveBeenCalledOnce();
    expect(setup.repository.abort).not.toHaveBeenCalled();
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it.each([
    ["active call", { activeCall: true }],
    ["queue in-use", { inUse: true }],
    ["unknown endpoint", { omitEndpoint: true }],
  ] as const)("does not let source registration mask a terminal %s blocker", async (_label, providerState) => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      providerState: { registered: true, ...providerState },
    });

    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({ status: 409 });

    expect(setup.provider).toHaveBeenCalledOnce();
    expect(setup.sleep).not.toHaveBeenCalled();
    expect(setup.repository.abort).toHaveBeenCalledOnce();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });

  it("does not let source registration mask a pending telephony command", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      providerState: { registered: true },
      commands: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        call_id: null,
        command_type: "call.hangup",
        extension_id: seatId("20"),
        provider_response: null,
        request_payload: {},
        status: "queued",
      }],
    });

    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({ status: 409 });

    expect(setup.provider).toHaveBeenCalledOnce();
    expect(setup.sleep).not.toHaveBeenCalled();
    expect(setup.repository.abort).toHaveBeenCalledOnce();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });

  it("removes only the actor's old unapplied priority draft before workplace recovery", async () => {
    const setup = abandonedPriorityDraftClient({ actorProfileId: ids.actor, updatedAt: "2026-08-07T07:50:00.000Z" });

    await expect(recoverAbandonedWorkplacePriorityDraft(actor, {
      client: setup.client as never,
      repository: { databaseNow: vi.fn(async () => now) } as never,
    })).resolves.toBe("recovered");

    expect(setup.state.metadata).not.toHaveProperty("workplacePriorityDraft");
    expect(setup.state.metadata).toMatchObject({
      dispatchRouting: {
        revision: 1,
        currentPlan: { "601": "20", "602": "21", "603": null },
      },
    });
    expect(setup.state.auditInserts).toEqual([
      expect.objectContaining({
        actor_profile_id: ids.actor,
        action: "telephony.workplace.priority.draft.abandoned",
        after_payload: expect.objectContaining({ reason: "stale_unapplied_draft" }),
      }),
    ]);
  });

  it("keeps fresh or foreign unapplied priority drafts fail-closed", async () => {
    const fresh = abandonedPriorityDraftClient({ actorProfileId: ids.actor, updatedAt: "2026-08-07T07:59:00.000Z" });
    await expect(recoverAbandonedWorkplacePriorityDraft(actor, {
      client: fresh.client as never,
      repository: { databaseNow: vi.fn(async () => now) } as never,
    })).resolves.toBe("none");
    expect(fresh.state.metadata).toHaveProperty("workplacePriorityDraft");
    expect(fresh.state.auditInserts).toEqual([]);

    const foreign = abandonedPriorityDraftClient({ actorProfileId: ids.other, updatedAt: "2026-08-07T07:00:00.000Z" });
    await expect(recoverAbandonedWorkplacePriorityDraft(actor, {
      client: foreign.client as never,
      repository: { databaseNow: vi.fn(async () => now) } as never,
    })).resolves.toBe("none");
    expect(foreign.state.metadata).toHaveProperty("workplacePriorityDraft");
    expect(foreign.state.auditInserts).toEqual([]);
  });

  it("accepts the final SIP unregister response without waiting for the cached VIPTel REST registration bit", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      providerStates: [{ registered: true }],
    });

    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserDisconnectOutcome: "accepted",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toEqual({
      result: { state: "confirmed", message: "Pracovné miesto je uvoľnené." },
    });

    expect(setup.provider).toHaveBeenCalledOnce();
    expect(setup.repository.markProviderChecked).toHaveBeenCalledOnce();
    expect(setup.repository.abort).not.toHaveBeenCalled();
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("does not block a workstation leave on an in-flight read-only provider snapshot", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      commands: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        call_id: null,
        command_type: "provider.snapshot",
        extension_id: null,
        provider_response: null,
        request_payload: { personalExtensions: ["20", "21", "22", "23"] },
        status: "sent",
      }],
    });

    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserDisconnectOutcome: "accepted",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toEqual({
      result: { state: "confirmed", message: "Pracovné miesto je uvoľnené." },
    });
    expect(setup.repository.abort).not.toHaveBeenCalled();
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("does not block a workstation leave on an accepted DTMF intent after its call ended", async () => {
    const callId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      calls: [{ id: callId, status: "ended" }],
      commands: [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        call_id: callId,
        command_type: "call.transfer.dtmf",
        extension_id: seatId("21"),
        provider_response: null,
        request_payload: { source: "21", destination: "20" },
        status: "accepted",
      }],
    });

    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserDisconnectOutcome: "accepted",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "confirmed" } });
    expect(setup.repository.abort).not.toHaveBeenCalled();
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("allows a planned workstation to leave while explicitly outside its VIPTel queue", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      providerState: { offlineExtension: "20" },
    });

    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);
    await expect(confirmDynamicWorkplaceChange(actor, {
      browserDisconnectOutcome: "accepted",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "confirmed" } });
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("does not retry a non-registration provider blocker after browser disconnect", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      providerState: { activeCall: true },
    });

    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserDisconnectOutcome: "accepted",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({ status: 409 });

    expect(setup.provider).toHaveBeenCalledOnce();
    expect(setup.sleep).not.toHaveBeenCalled();
    expect(setup.repository.abort).toHaveBeenCalledOnce();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });

  it.each(["complete", "partial"] as const)(
    "recovers a lost %s DTMF cleanup after provider-idle proof and completes leave",
    async (outcome) => {
      const source = seats({ "20": ids.actor });
      source[0].metadata = {
        ...jsonRecord(source[0].metadata),
        assignmentGeneration: generationId("20"),
        assignmentActionClaim: {
          action: "call.transfer.dtmf",
          claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          claimedAt: "2026-08-07T07:55:00.000Z",
          generation: generationId("20"),
          lifecycleEpoch: generationId("20"),
          profileId: ids.actor,
        },
      };
      const setup = harness({
        extensions: source,
        leases: [lease("20", ids.actor, ids.browser)],
        commands: [{
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          call_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          command_type: "call.transfer.dtmf",
          extension_id: seatId("20"),
          status: "accepted",
          provider_response: { browserDtmfDelivery: { outcome } },
          request_payload: {
            assignmentGuard: {
              claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              extension: "20",
              extensionId: seatId("20"),
              generation: generationId("20"),
              lifecycleEpoch: generationId("20"),
              profileId: ids.actor,
            },
          },
        }],
      });

      await expect(leaveDynamicWorkplaceSeat(actor, {
        browserInstanceId: ids.browser,
        idempotencyKey: ids.operation,
      }, setup.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });
      await expect(confirmDynamicWorkplaceChange(actor, {
        browserInstanceId: ids.browser,
        idempotencyKey: ids.operation,
        operationId: ids.operation,
      }, setup.dependencies)).resolves.toMatchObject({ result: { state: "confirmed" } });
      expect(setup.provider).toHaveBeenCalledTimes(2);
      expect(setup.repository.finalize).toHaveBeenCalledOnce();
    },
  );

  it("recovers a lost DTMF delivery report after the exact call ended and completes leave", async () => {
    const callId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const source = seats({ "20": ids.actor });
    source[0].metadata = {
      ...jsonRecord(source[0].metadata),
      assignmentGeneration: generationId("20"),
      assignmentActionClaim: {
        action: "call.transfer.dtmf",
        claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        claimedAt: "2026-08-07T07:55:00.000Z",
        generation: generationId("20"),
        lifecycleEpoch: generationId("20"),
        profileId: ids.actor,
      },
    };
    const setup = harness({
      calls: [{ id: callId, status: "ended" }],
      extensions: source,
      leases: [lease("20", ids.actor, ids.browser)],
      commands: [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        call_id: callId,
        command_type: "call.transfer.dtmf",
        extension_id: seatId("20"),
        status: "accepted",
        provider_response: {},
        request_payload: {
          assignmentGuard: {
            claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            extension: "20",
            extensionId: seatId("20"),
            generation: generationId("20"),
            lifecycleEpoch: generationId("20"),
            profileId: ids.actor,
          },
        },
      }],
    });

    await expect(leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });
    await expect(confirmDynamicWorkplaceChange(actor, {
      browserDisconnectOutcome: "accepted",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "confirmed" } });
    expect(setup.provider).toHaveBeenCalledTimes(2);
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("recovers an aged crash-before-response webphone claim only after fresh provider-idle proof", async () => {
    const source = seats({ "20": ids.actor });
    source[0].metadata = {
      ...jsonRecord(source[0].metadata),
      assignmentGeneration: generationId("20"),
      assignmentActionClaim: {
        action: "webphone.session.issue",
        claimId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        claimedAt: "2026-08-07T07:55:00.000Z",
        generation: generationId("20"),
        lifecycleEpoch: generationId("20"),
        profileId: ids.actor,
      },
    };
    const setup = harness({
      extensions: source,
      leases: [lease("20", ids.actor, ids.browser)],
    });

    await expect(leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });
    expect(setup.provider).toHaveBeenCalledOnce();
    expect(setup.repository.begin).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing immutable evidence", { probeEvidence: "missing" as const }, "queue_probe_evidence_mismatch"],
    ["mismatched immutable evidence", { probeEvidence: "mismatch" as const }, "queue_probe_evidence_mismatch"],
    ["a waiting caller", { providerState: { waitingCalls: 1 } }, "queue_probe_waiting_calls"],
    [
      "an expired probe window",
      { providerState: { capturedAt: "2026-08-07T10:00:00.000Z" } },
      "queue_probe_window_closed",
    ],
  ])("aborts a queued-seat leave when the controlled probe has %s", async (_label, overrides, code) => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
      ...overrides,
    });
    await leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({ code, status: 409 });

    expect(setup.repository.abort).toHaveBeenCalledOnce();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });

  it("lets an acknowledged production static-SIP pilot leave a queued source without queue-probe env", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "production_static_pilot";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "production";
    process.env.VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT = "I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT";
    process.env.VERCEL_ENV = "production";
    for (const key of [
      "VIPTEL_WORKPLACE_QUEUE_CAPABILITY",
      "VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_PROFILE_ID",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_SOURCE_EXTENSION",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_STARTS_AT",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_ENDS_AT",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_FALLBACK_REFERENCE",
    ]) delete process.env[key];
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
    });

    await expect(leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "confirmed" } });
    expect(setup.repository.abort).not.toHaveBeenCalled();
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("lets an acknowledged production static-SIP pilot switch from a queued source without queue-probe env", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "production_static_pilot";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "production";
    process.env.VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT = "I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT";
    process.env.VERCEL_ENV = "production";
    for (const key of [
      "VIPTEL_WORKPLACE_QUEUE_CAPABILITY",
      "VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_PROFILE_ID",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_SOURCE_EXTENSION",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_STARTS_AT",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_ENDS_AT",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_FALLBACK_REFERENCE",
    ]) delete process.env[key];
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "disconnect_required" } });

    await expect(confirmDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed" },
      lease: { extension: "23" },
    });
    expect(setup.repository.abort).not.toHaveBeenCalled();
    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("blocks a controlled queued-seat probe for any other source seat before disconnect", async () => {
    process.env.VIPTEL_WORKPLACE_QUEUE_PROBE_SOURCE_EXTENSION = "21";
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
    });

    await expect(leaveDynamicWorkplaceSeat(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({ code: "queue_vacate_not_verified", status: 409 });

    expect(setup.repository.begin).not.toHaveBeenCalled();
    expect(setup.provider).not.toHaveBeenCalled();
  });

  it("cancels a precommit switch after browser disconnect failure and releases its resource claim", async () => {
    const setup = harness({
      extensions: seats({ "20": ids.actor }),
      leases: [lease("20", ids.actor, ids.browser)],
    });
    await selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    await expect(cancelDynamicWorkplaceChange(actor, {
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
      operationId: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ result: { state: "confirmed" } });

    expect(setup.repository.abort).toHaveBeenCalledWith(expect.objectContaining({
      claimGeneration: ids.claim,
      operationId: ids.operation,
    }));
    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });

  it("rolls a lost finalize response forward from the exact completed readback", async () => {
    const setup = harness({ extensions: seats(), finalizeMode: "commit_then_throw" });

    const result = await selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    expect(result).toMatchObject({
      result: { state: "confirmed", noOp: true },
      lease: { extension: "23", leaderEpoch: 1, leaseVersion: 1 },
      resumeSecret: expect.any(String),
    });
    expect(setup.repository.abort).not.toHaveBeenCalled();
  });

  it("aborts an exact precommit finalize rejection and preserves the original ownership", async () => {
    const setup = harness({ extensions: seats(), finalizeMode: "reject" });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({ code: "workplace_conflict", status: 409 });

    expect(setup.repository.abort).toHaveBeenCalledOnce();
    expect(setup.repository.abort).toHaveBeenCalledWith(expect.objectContaining({
      operationId: ids.operation,
      claimGeneration: ids.claim,
    }));
  });

  it("allows an expired disconnected owner to be replaced but delegates the exact freshness race to begin RPC", async () => {
    const setup = harness({
      extensions: seats({ "23": ids.other }),
      leases: [lease("23", ids.other, ids.otherBrowser, { expiresAt: "2026-08-07T07:59:59.000Z" })],
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ lease: { extension: "23" } });
    expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({
      expectedTargetHeartbeatAt: "2026-08-07T07:59:00.000Z",
      kind: "takeover",
    }));

    const raced = harness({
      extensions: seats({ "23": ids.other }),
      leases: [lease("23", ids.other, ids.otherBrowser)],
      beginError: new Error("target heartbeat changed"),
    });
    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, raced.dependencies)).rejects.toMatchObject({ code: "workplace_conflict", status: 409 });
    expect(raced.provider).not.toHaveBeenCalled();
  });

  it("explains when an old browser lease is still active instead of reporting an unrelated conflict", async () => {
    const setup = harness({
      extensions: seats({ "23": ids.other }),
      leases: [lease("23", ids.other, ids.otherBrowser, { expiresAt: "2026-08-07T07:59:59.000Z" })],
      beginError: new WorkplaceOperationRepositoryError(
        "begin failed",
        "begin",
        "55P03: WORKPLACE_TARGET_ACTIVE",
      ),
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({
      code: "lease_lost",
      status: 409,
      message: expect.stringContaining("Predchádzajúce okno"),
    });
  });

  it("does not tell an operator to retry an idempotency conflict that can never succeed", async () => {
    const setup = harness({
      extensions: seats({ "23": ids.other }),
      leases: [lease("23", ids.other, ids.otherBrowser)],
      beginError: new WorkplaceOperationRepositoryError(
        "begin failed",
        "begin",
        "23505: WORKPLACE_IDEMPOTENCY_CONFLICT",
      ),
    });

    const error = await selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies).catch((caught: unknown) => caught);

    // The generic fallback said "obnov stav a skus to znova". Repeating the
    // action reuses the same idempotency key, which is exactly what the
    // database rejected, so that advice could never work.
    expect(error).toMatchObject({ code: "workplace_conflict", status: 409 });
    expect((error as { message: string }).message).toContain("novú akciu");
    expect((error as { message: string }).message).not.toBe(
      "Pracovné miesto medzitým zmenila iná požiadavka. Obnov stav a skús to znova.",
    );
  });

  it("names the real reason when the actor already holds another seat", async () => {
    const setup = harness({
      extensions: seats({ "23": ids.other }),
      leases: [lease("23", ids.other, ids.otherBrowser)],
      beginError: new WorkplaceOperationRepositoryError(
        "begin failed",
        "begin",
        "P0001: WORKPLACE_ACTOR_ALREADY_HAS_SEAT",
      ),
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({
      code: "workplace_conflict",
      status: 409,
      message: expect.stringContaining("iné pracovné miesto"),
    });
  });

  it("recovers a canonical unowned seat whose stale SIP contact survived release", async () => {
    const extensions = seats();
    const target = extensions.find((extension) => extension.extension === "20");
    if (!target) throw new Error("Unowned registered-seat fixture is incomplete.");
    target.is_registered = true;
    const setup = harness({ extensions, providerState: { registered: true } });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ lease: { extension: "20" } });

    expect(setup.repository.begin).toHaveBeenCalledWith(expect.objectContaining({ kind: "claim" }));
    expect(setup.repository.finalize).toHaveBeenCalledOnce();

    const blockedExtensions = seats();
    const blockedTarget = blockedExtensions.find((extension) => extension.extension === "20");
    if (!blockedTarget) throw new Error("Blocked unowned registered-seat fixture is incomplete.");
    blockedTarget.is_registered = true;
    const blocked = harness({
      extensions: blockedExtensions,
      providerState: { activeCall: true, registered: true },
    });
    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: "12121212-1212-4121-8121-121212121212",
    }, blocked.dependencies)).rejects.toMatchObject({ status: 409 });
    expect(blocked.repository.finalize).not.toHaveBeenCalled();
  });

  it.each([
    ["active call", { activeCall: true }],
    ["queue in-use", { inUse: true }],
    ["unknown endpoint", { omitEndpoint: true }],
  ] as const)("aborts before ownership commit when VIPTel reports %s", async (_label, providerState) => {
    const setup = harness({ extensions: seats(), providerState });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({ status: 409 });

    expect(setup.repository.abort).toHaveBeenCalledOnce();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });

  it("preserves an offline paused queue membership so the new owner can become available after connect", async () => {
    const setup = harness({ extensions: seats(), providerState: { paused: true } });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "20",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({ lease: { extension: "20" } });

    expect(setup.repository.finalize).toHaveBeenCalledOnce();
  });

  it("recovers DB-time-expired precommit operations before starting a new claim", async () => {
    const expired = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const setup = harness({ extensions: seats(), expiredRecoveryIds: [expired] });

    await selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    expect(setup.repository.recoverExpired).toHaveBeenCalledWith({
      operationId: expired,
      organizationId: ids.organization,
      recoveryOwner: `request:${ids.actor}`,
    });
  });

  it("does not replay the original resume secret after that lease secret was rotated", async () => {
    const leaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const generation = generationId("23");
    const targetLease = lease("23", ids.actor, ids.browser, {
      id: leaseId,
      generation,
      resumeSecretHash: sha256("already-rotated-secret"),
    });
    const completed = operationRow({
      phase: "completed",
      source_extension_id: null,
      target_extension_id: seatId("23"),
      result_safe: {
        assignmentGeneration: generation,
        expiresAt: targetLease.expires_at,
        leaderEpoch: 1,
        leaseId,
        leaseVersion: 1,
      },
    });
    const setup = harness({
      extensions: seats({ "23": ids.actor }),
      leases: [targetLease],
      operations: [completed],
    });

    const result = await selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies);

    expect(result.lease).toMatchObject({ leaseId, extension: "23" });
    expect(result).not.toHaveProperty("resumeSecret");
    expect(deriveResumeSecret(ids.operation, leaseId, ids.browser)).not.toBe("already-rotated-secret");
  });

  it("replays a completed claim while an independent routing operation is active", async () => {
    const leaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const generation = generationId("23");
    const resumeSecret = deriveResumeSecret(ids.operation, leaseId, ids.browser);
    const targetLease = lease("23", ids.actor, ids.browser, {
      id: leaseId,
      generation,
      resumeSecretHash: sha256(resumeSecret),
    });
    const completed = operationRow({
      phase: "completed",
      committed_at: now,
      completed_at: now,
      source_extension_id: null,
      target_extension_id: seatId("23"),
      result_safe: {
        assignmentGeneration: generation,
        expiresAt: targetLease.expires_at,
        leaderEpoch: 1,
        leaseId,
        leaseVersion: 1,
      },
    });
    const setup = harness({
      extensions: seats({ "23": ids.actor }),
      leases: [targetLease],
      operations: [completed],
      routingOperationActive: true,
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).resolves.toMatchObject({
      result: { state: "confirmed", noOp: true },
      lease: { leaseId, extension: "23" },
      resumeSecret,
    });

    expect(setup.client.from).not.toHaveBeenCalledWith("motorist_telephony_queues");
    expect(setup.recoverBlockingRouting).not.toHaveBeenCalled();
    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });

  it("marks an old completed replay superseded after a later takeover", async () => {
    const oldLeaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const oldGeneration = generationId("23");
    const completed = operationRow({
      phase: "completed",
      committed_at: now,
      completed_at: now,
      source_extension_id: null,
      target_extension_id: seatId("23"),
      result_safe: {
        assignmentGeneration: oldGeneration,
        expiresAt: "2026-08-07T08:01:00.000Z",
        leaderEpoch: 1,
        leaseId: oldLeaseId,
        leaseVersion: 1,
      },
    });
    const setup = harness({
      extensions: seats({ "23": ids.other }),
      leases: [lease("23", ids.other, ids.otherBrowser)],
      operations: [completed],
    });

    await expect(selectDynamicWorkplaceSeat(actor, {
      extension: "23",
      browserInstanceId: ids.browser,
      idempotencyKey: ids.operation,
    }, setup.dependencies)).rejects.toMatchObject({
      code: "workplace_operation_superseded",
      status: 409,
    });

    expect(setup.repository.finalize).not.toHaveBeenCalled();
  });
});

type ProviderState = {
  activeCall?: boolean;
  capturedAt?: string;
  inUse?: boolean;
  omitEndpoint?: boolean;
  offlineExtension?: "20" | "21" | "22" | "23";
  paused?: boolean;
  registered?: boolean;
  registeredExtension?: "20" | "21" | "22" | "23";
  waitingCalls?: number;
};

type ExtensionRow = Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"];
type LeaseRow = Database["public"]["Tables"]["motorist_workplace_leases"]["Row"];
type OperationRow = Database["public"]["Tables"]["motorist_workplace_operations"]["Row"];

type HarnessInput = {
  beginError?: Error;
  beginMode?: "commit_then_throw";
  claimRegistry?: Map<string, string>;
  calls?: Array<Record<string, unknown>>;
  commands?: Array<Record<string, unknown>>;
  completeOperationOnSecondRead?: boolean;
  expiredRecoveryIds?: string[];
  extensions: ExtensionRow[];
  finalizeMode?: "commit_then_throw" | "reject" | "success";
  leases?: LeaseRow[];
  operations?: OperationRow[];
  probeEvidence?: "mismatch" | "missing" | "valid";
  providerState?: ProviderState;
  providerStates?: ProviderState[];
  recoverBlockingRoutingState?: "none" | "recovered" | "pending";
  routingOperationActive?: boolean;
};

function harness(input: HarnessInput) {
  const state = {
    expiredRecoveryIds: input.expiredRecoveryIds ?? [],
    calls: input.calls ?? [],
    commands: input.commands ?? [],
    completeOperationOnSecondRead: input.completeOperationOnSecondRead ?? false,
    extensions: input.extensions,
    leases: input.leases ?? [],
    operations: [...(input.operations ?? [])],
    probeEvidence: input.probeEvidence ?? "valid",
    routingOperationActive: input.routingOperationActive ?? false,
    operationReadCount: 0,
  };
  const client = fakeClient(state);
  let providerRead = 0;
  const provider = vi.fn(async () => {
    const sequence = input.providerStates;
    if (!sequence?.length) return providerSnapshot(input.providerState);
    const state = sequence[Math.min(providerRead, sequence.length - 1)];
    providerRead += 1;
    return providerSnapshot(state);
  });
  const sleep = vi.fn(async () => undefined);
  const recoverBlockingRouting = vi.fn(async () => {
    const result = input.recoverBlockingRoutingState ?? "none";
    if (result === "recovered") state.routingOperationActive = false;
    return result;
  });
  const repository = {
    databaseNow: vi.fn(async () => now),
    load: vi.fn(),
    begin: vi.fn(async (operationInput: BeginWorkplaceOperationInput) => {
      if (input.beginError) throw input.beginError;
      const resourceKeys = workplaceResourceClaimKeys(operationInput.resources);
      const conflictingResource = resourceKeys.find((key) => {
        const owner = input.claimRegistry?.get(key);
        return owner !== undefined && owner !== operationInput.operationId;
      });
      if (conflictingResource) throw new Error(`simulated TELEPHONY_RESOURCE_BUSY: ${conflictingResource}`);
      for (const key of resourceKeys) input.claimRegistry?.set(key, operationInput.operationId);
      const row = operationRow({
        id: operationInput.operationId,
        idempotency_key: operationInput.idempotencyKey,
        intent_hash: operationInput.intentHash,
        kind: operationInput.kind,
        source_extension_id: operationInput.sourceExtensionId,
        target_extension_id: operationInput.targetExtensionId,
        source_lease_id: operationInput.sourceLeaseId,
        target_lease_id: operationInput.targetLeaseId,
        browser_instance_id: operationInput.browserInstanceId,
        expected_source_assignment_generation: operationInput.expectedSourceAssignmentGeneration,
        expected_target_assignment_generation: operationInput.expectedTargetAssignmentGeneration,
        expected_source_lease_version: operationInput.expectedSourceLeaseVersion,
        expected_target_lease_version: operationInput.expectedTargetLeaseVersion,
        expected_source_heartbeat_at: operationInput.expectedSourceHeartbeatAt,
        expected_target_heartbeat_at: operationInput.expectedTargetHeartbeatAt,
      });
      state.operations.push(row);
      if (input.beginMode === "commit_then_throw") {
        throw new Error("simulated lost begin response");
      }
      return {
        operationId: operationInput.operationId,
        phase: "claimed" as const,
        claimGeneration: ids.claim,
        claimExpiresAt: "2026-08-07T08:01:30.000Z",
        databaseNow: now,
        idempotent: false,
        terminalResult: null,
      };
    }),
    markProviderChecked: vi.fn(async ({ operationId }: MarkWorkplaceProviderCheckedInput) => {
      const row = state.operations.find((candidate) => candidate.id === operationId);
      if (row) {
        row.phase = "provider_checked";
        row.provider_checked_at = now;
      }
      return {
        operationId,
        phase: "provider_checked" as const,
        claimGeneration: ids.claim,
        claimExpiresAt: "2026-08-07T08:01:30.000Z",
        databaseNow: now,
        idempotent: false,
        terminalResult: null,
      };
    }),
    finalize: vi.fn(async (finalizeInput: FinalizeWorkplaceOperationInput) => {
      if (input.finalizeMode === "reject") throw new Error("simulated finalize validation rejection");
      const result = {
        operationId: finalizeInput.operationId,
        phase: "completed" as const,
        leaseId: finalizeInput.newLeaseId,
        assignmentGeneration: finalizeInput.newAssignmentGeneration,
        leaderEpoch: finalizeInput.newLeaseId ? 1 : null,
        leaseVersion: finalizeInput.newLeaseId ? 1 : null,
        expiresAt: finalizeInput.newLeaseId ? "2026-08-07T08:01:00.000Z" : null,
        databaseNow: now,
      };
      if (input.finalizeMode === "commit_then_throw") {
        applyCommittedFinalize(state, finalizeInput, result);
        throw new Error("simulated lost finalize response");
      }
      return result;
    }),
    abort: vi.fn(async ({ operationId }: { operationId: string }) => {
      const row = state.operations.find((candidate) => candidate.id === operationId);
      if (row) row.phase = "aborted";
      return {
        operationId,
        phase: "aborted" as const,
        databaseNow: now,
      };
    }),
    recoverExpired: vi.fn(async ({ operationId }: { operationId: string }) => ({
      operationId,
      phase: "aborted" as const,
      databaseNow: now,
      recovered: true,
    })),
    renewClaim: vi.fn(async ({ operationId }: { operationId: string }) => ({
      operationId,
      databaseNow: now,
    })),
    releaseTerminalClaims: vi.fn(async ({ operationId }: { operationId: string }) => ({
      operationId,
      releasedClaims: 0,
      databaseNow: now,
    })),
    markManualRecovery: vi.fn(async ({ operationId }: { operationId: string }) => ({
      operationId,
      phase: "manual_recovery_required" as const,
      databaseNow: now,
    })),
    reapLease: vi.fn(async ({ leaseId }: { leaseId: string }) => ({
      leaseId,
      reaped: true,
      databaseNow: now,
    })),
    verify: vi.fn(),
    heartbeat: vi.fn(),
    resume: vi.fn(),
  } satisfies WorkplaceOperationRepository;
  return {
    client,
    provider,
    repository,
    recoverBlockingRouting,
    sleep,
    dependencies: {
      client: client as never,
      repository: repository as WorkplaceOperationRepository,
      requestProviderSnapshot: provider,
      recoverBlockingRouting,
      resumeSecretKey: resumeKey,
      sleep,
    },
  };
}

function enableProductionStaticPilot() {
  process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "production_static_pilot";
  process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "production";
  process.env.VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT = "I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT";
  process.env.VERCEL_ENV = "production";
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS;
}

function workplaceResourceClaimKeys(value: unknown) {
  if (!Array.isArray(value)) throw new Error("workplace resource claims must be an array");
  return value.map((entry) => {
    const claim = jsonRecord(entry);
    if (typeof claim.resource_type !== "string" || typeof claim.resource_id !== "string") {
      throw new Error("workplace resource claim is malformed");
    }
    return `${claim.resource_type}:${claim.resource_id}`;
  });
}

function fakeClient(state: {
  calls: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  completeOperationOnSecondRead: boolean;
  expiredRecoveryIds: string[];
  extensions: ExtensionRow[];
  leases: LeaseRow[];
  operations: OperationRow[];
  probeEvidence: "mismatch" | "missing" | "valid";
  routingOperationActive: boolean;
  operationReadCount: number;
}) {
  return {
    from: vi.fn((table: string) => query((calls) => {
      if (table === "motorist_telephony_extensions") {
        const id = eqValue(calls, "id");
        return {
          data: id ? state.extensions.find((extension) => extension.id === id) ?? null : state.extensions,
          error: null,
        };
      }
      if (table === "motorist_telephony_queues") {
        return { data: queueRows(state.routingOperationActive), error: null };
      }
      if (table === "motorist_workplace_leases") {
        const id = eqValue(calls, "id");
        return { data: id ? state.leases.find((lease) => lease.id === id) ?? null : state.leases, error: null };
      }
      if (table === "motorist_telephony_commands") return { data: state.commands, error: null };
      if (table === "motorist_calls") return { data: state.calls, error: null };
      if (table === "motorist_audit_log") {
        if (state.probeEvidence === "missing") return { data: null, error: null };
        return {
          data: queueProbeEvidence(state.probeEvidence === "mismatch"),
          error: null,
        };
      }
      if (table === "motorist_workplace_operations") {
        if (calls.some((call) => call.method === "in" && call.args[0] === "phase")) {
          return { data: state.expiredRecoveryIds.map((id) => ({ id })), error: null };
        }
        const idempotencyKey = eqValue(calls, "idempotency_key");
        const id = eqValue(calls, "id");
        if (idempotencyKey || id) {
          state.operationReadCount += 1;
          if (state.completeOperationOnSecondRead && state.operationReadCount === 2) {
            applyExternallyCompletedClaim(state);
          }
        }
        const row = state.operations.find((candidate) =>
          idempotencyKey ? candidate.idempotency_key === idempotencyKey : candidate.id === id);
        return { data: row ?? null, error: null };
      }
      throw new Error(`Unexpected table ${table}`);
    })),
  };
}

function applyExternallyCompletedClaim(state: {
  extensions: ExtensionRow[];
  leases: LeaseRow[];
  operations: OperationRow[];
}) {
  const operation = state.operations.find((candidate) => candidate.id === ids.operation);
  const target = state.extensions.find((extension) => extension.id === seatId("23"));
  if (!operation || !target) throw new Error("external completion fixture is incomplete");
  const leaseIdValue = "abababab-abab-4bab-8bab-abababababab";
  const generation = "acacacac-acac-4cac-8cac-acacacacacac";
  const expiresAt = "2026-08-07T08:01:00.000Z";
  const resumeSecret = deriveResumeSecret(operation.id, leaseIdValue, operation.browser_instance_id);
  operation.phase = "completed";
  operation.committed_at = now;
  operation.completed_at = now;
  operation.result_safe = {
    assignmentGeneration: generation,
    expiresAt,
    leaderEpoch: 1,
    leaseId: leaseIdValue,
    leaseVersion: 1,
  };
  target.profile_id = ids.actor;
  target.metadata = {
    ...jsonRecord(target.metadata),
    assignmentGeneration: generation,
    assignmentLifecycle: {
      schemaVersion: 1,
      epoch: generation,
      state: "assigned",
      extensionId: target.id,
      extension: target.extension,
      profileId: ids.actor,
      assignmentMode: "workplace_claim",
      assignedAt: now,
      assignedBy: ids.actor,
    },
  };
  state.leases.push(lease("23", ids.actor, ids.browser, {
    expiresAt,
    generation,
    heartbeatAt: now,
    id: leaseIdValue,
    resumeSecretHash: sha256(resumeSecret),
  }));
}

function applyCommittedFinalize(
  state: {
    extensions: ExtensionRow[];
    leases: LeaseRow[];
    operations: OperationRow[];
  },
  input: FinalizeWorkplaceOperationInput,
  result: {
    assignmentGeneration: string | null;
    expiresAt: string | null;
    leaderEpoch: number | null;
    leaseId: string | null;
    leaseVersion: number | null;
  },
) {
  const operation = state.operations.find((candidate) => candidate.id === input.operationId);
  if (!operation) throw new Error("finalize test operation missing");
  operation.phase = "completed";
  operation.committed_at = now;
  operation.completed_at = now;
  operation.result_safe = {
    assignmentGeneration: result.assignmentGeneration,
    expiresAt: result.expiresAt,
    leaderEpoch: result.leaderEpoch,
    leaseId: result.leaseId,
    leaseVersion: result.leaseVersion,
  };

  if (operation.source_extension_id) {
    const source = state.extensions.find((extension) => extension.id === operation.source_extension_id);
    if (source) {
      const sourceLifecycle = jsonRecord(input.sourceLifecycle);
      source.profile_id = null;
      source.metadata = {
        ...jsonRecord(source.metadata),
        assignmentGeneration: typeof sourceLifecycle.epoch === "string" ? sourceLifecycle.epoch : null,
        assignmentLifecycle: input.sourceLifecycle,
      };
    }
    state.leases = state.leases.filter((lease) => lease.id !== operation.source_lease_id);
  }

  if (
    operation.target_extension_id && input.newLeaseId && input.newAssignmentGeneration &&
    input.newBrowserInstanceId && input.newResumeSecretHash && result.expiresAt
  ) {
    const target = state.extensions.find((extension) => extension.id === operation.target_extension_id);
    if (!target) throw new Error("finalize test target missing");
    target.profile_id = ids.actor;
    target.metadata = {
      ...jsonRecord(target.metadata),
      assignmentGeneration: input.newAssignmentGeneration,
      assignmentLifecycle: input.targetLifecycle,
    };
    state.leases = state.leases.filter((lease) => lease.id !== operation.target_lease_id);
    state.leases.push({
      id: input.newLeaseId,
      organization_id: ids.organization,
      extension_id: target.id,
      profile_id: ids.actor,
      assignment_generation: input.newAssignmentGeneration,
      browser_instance_id: input.newBrowserInstanceId,
      lease_version: 1,
      leader_epoch: 1,
      resume_secret_hash: input.newResumeSecretHash,
      resume_requested_at: null,
      heartbeat_suspended_at: null,
      heartbeat_suspension_operation_id: null,
      state: "active",
      claimed_at: now,
      heartbeat_at: now,
      expires_at: result.expiresAt,
      ended_at: null,
      ended_reason: null,
      revoked_by: null,
      created_at: now,
      updated_at: now,
    });
  }
}

function queueProbeEvidence(mismatch: boolean) {
  const root = queueRows()[0];
  return {
    id: ids.evidence,
    action: CONTROLLED_QUEUE_PROBE_AUDIT_ACTION_FOR_TEST,
    entity_type: "motorist_telephony_queues",
    entity_id: root.id,
    after_payload: {
      schemaVersion: 1,
      capability: "controlled_probe",
      organizationId: ids.organization,
      profileId: ids.actor,
      sourceExtension: mismatch ? "21" : "20",
      rootQueueId: root.id,
      startsAt: "2026-08-07T07:30:00.000Z",
      endsAt: "2026-08-07T09:30:00.000Z",
      fallbackReference: "approved-test-fallback",
    },
  };
}

const CONTROLLED_QUEUE_PROBE_AUDIT_ACTION_FOR_TEST = "telephony.workplace.queue_probe.approved";

function query(result: (calls: Array<{ method: string; args: unknown[] }>) => unknown) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const proxy = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result(calls)).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return property === "maybeSingle" ? Promise.resolve(result(calls)) : proxy;
      };
    },
  });
  return proxy;
}

function eqValue(calls: Array<{ method: string; args: unknown[] }>, column: string) {
  return calls.find((call) => call.method === "eq" && call.args[0] === column)?.args[1];
}

function seats(owners: Partial<Record<"20" | "21" | "22" | "23", string>> = {}): ExtensionRow[] {
  return (["20", "21", "22", "23"] as const).map((extension) => {
    const owner = owners[extension] ?? null;
    const lifecycle = {
      schemaVersion: 1,
      epoch: generationId(extension),
      state: owner ? "assigned" : "unassigned",
      extensionId: seatId(extension),
      extension,
      profileId: owner,
      assignmentMode: "workplace_claim",
      assignedAt: "2026-08-07T07:00:00.000Z",
      assignedBy: owner ?? ids.actor,
      ...(!owner ? { unassignedAt: "2026-08-07T07:30:00.000Z", unassignedBy: ids.actor } : {}),
    };
    return {
      id: seatId(extension),
      organization_id: ids.organization,
      provider: "viptel",
      external_id: extension,
      extension,
      profile_id: owner,
      active: true,
      metadata: { assignmentLifecycle: lifecycle },
      display_name: `Pracovisko ${extension}`,
      outbound_cid: null,
      call_forwarding: null,
      is_registered: false,
      is_viptel_phone_active: false,
      allowed_changes: [],
      last_synced_at: now,
      raw_payload: {},
      workplace_seat_generation: generationId(extension),
      created_at: now,
      updated_at: now,
    };
  });
}

function lease(
  extension: "20" | "21" | "22" | "23",
  profileId: string,
  browserInstanceId: string,
  overrides: {
    expiresAt?: string;
    generation?: string;
    heartbeatAt?: string;
    id?: string;
    leaseVersion?: number;
    resumeSecretHash?: string;
  } = {},
): LeaseRow {
  return {
    id: overrides.id ?? leaseId(extension),
    organization_id: ids.organization,
    extension_id: seatId(extension),
    profile_id: profileId,
    assignment_generation: overrides.generation ?? generationId(extension),
    browser_instance_id: browserInstanceId,
    lease_version: overrides.leaseVersion ?? 1,
    leader_epoch: 1,
    resume_secret_hash: overrides.resumeSecretHash ?? sha256(`resume-${extension}`),
    resume_requested_at: null,
    heartbeat_suspended_at: null,
    heartbeat_suspension_operation_id: null,
    state: "active",
    claimed_at: "2026-08-07T07:58:59.000Z",
    heartbeat_at: overrides.heartbeatAt ?? "2026-08-07T07:59:00.000Z",
    expires_at: overrides.expiresAt ?? "2026-08-07T08:00:00.000Z",
    ended_at: null,
    ended_reason: null,
    revoked_by: null,
    created_at: "2026-08-07T07:58:59.000Z",
    updated_at: "2026-08-07T07:58:59.000Z",
  };
}

function queueRows(operationActive = false) {
  const metadata = {
    dispatchRouting: {
      revision: 1,
      currentPlan: { "601": "20", "602": "21", "603": "22" },
      ...(operationActive
        ? {
            operation: {
              id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
              status: "applying",
            },
          }
        : {}),
    },
  };
  return (["601", "602", "603"] as const).map((externalId) => ({
    id: `eeeeeeee-eeee-4eee-8eee-000000000${externalId}`,
    external_id: externalId,
    metadata,
    updated_at: now,
  }));
}

type RoutingCommandFixture = {
  command_type: string;
  extension_id: string;
  id: string;
  idempotency_key: string;
  organization_id: string;
  provider: string;
  provider_response: Record<string, unknown>;
  queue_id: string;
  request_payload: Record<string, unknown>;
  requested_by: string;
  status: string;
};

function failedRoutingRecoveryFixture(): {
  command: RoutingCommandFixture;
  operation: DispatchRoutingOperation;
  root: Record<string, unknown>;
} {
  const queueId = "eeeeeeee-eeee-4eee-8eee-000000000601";
  const operationId = "12121212-1212-4212-8212-121212121212";
  const commandId = "13131313-1313-4313-8313-131313131313";
  const operation: DispatchRoutingOperation = {
    operationId,
    status: "applying",
    baseRevision: 1,
    targetRevision: 2,
    previousPlan: { "601": "20", "602": null, "603": null },
    targetPlan: { "601": "21", "602": null, "603": null },
    steps: [{
      stepIndex: 0,
      commandId,
      idempotencyKey: "14141414-1414-4414-8414-141414141414",
      commandType: "queue.add",
      action: "add",
      queue: "601",
      queueId,
      extension: "21",
      extensionId: seatId("21"),
      status: "pending",
    }],
    currentStep: 0,
    fallback: { queue: "601", extension: "20", queueId, extensionId: seatId("20") },
    affectedExtensions: ["20", "21"],
    assignmentGuards: [
      {
        claimId: "15151515-1515-4515-8515-151515151515",
        extension: "20",
        extensionId: seatId("20"),
        generation: generationId("20"),
        lifecycleEpoch: generationId("20"),
        profileId: null,
        routingOperationId: operationId,
        workplaceSeatGeneration: generationId("20"),
      },
      {
        claimId: "16161616-1616-4616-8616-161616161616",
        extension: "21",
        extensionId: seatId("21"),
        generation: generationId("21"),
        lifecycleEpoch: generationId("21"),
        profileId: ids.other,
        routingOperationId: operationId,
        workplaceSeatGeneration: generationId("21"),
      },
    ],
    rootMetadataGuard: {
      key: "workplacePriorityDraft",
      digest: "a".repeat(64),
      authorityId: "17171717-1717-4717-8717-171717171717",
    },
    actorProfileId: ids.other,
    createdAt: "2026-08-07T07:55:00.000Z",
    updatedAt: "2026-08-07T07:56:00.000Z",
  };
  const command: RoutingCommandFixture = {
    id: commandId,
    organization_id: ids.organization,
    provider: "viptel",
    requested_by: ids.other,
    status: "failed",
    command_type: "queue.add",
    idempotency_key: operation.steps[0].idempotencyKey,
    extension_id: seatId("21"),
    queue_id: queueId,
    request_payload: {
      queue: "601",
      action: "add",
      extension: "21",
      routingOperation: {
        operationId,
        stepIndex: 0,
        revision: 2,
        authorityDigest: dispatchRoutingOperationAuthorityDigest(ids.organization, operation),
      },
    },
    provider_response: { reason: "dispatch_failed", deliveryUncertain: false },
  };
  return {
    command,
    operation,
    root: {
      id: queueId,
      external_id: "601",
      metadata: {
        dispatchRouting: {
          revision: 1,
          currentPlan: operation.previousPlan,
          operation,
        },
      },
      updated_at: "2026-08-07T07:56:00.000Z",
    },
  };
}

function routingRecoveryClient(
  root: Record<string, unknown>,
  command: RoutingCommandFixture,
  leases: LeaseRow[],
) {
  return {
    from: vi.fn((table: string) => query(() => {
      if (table === "motorist_telephony_queues") return { data: root, error: null };
      if (table === "motorist_telephony_commands") return { data: command, error: null };
      if (table === "motorist_workplace_leases") return { data: leases, error: null };
      throw new Error(`Unexpected recovery table ${table}`);
    })),
  };
}

function abandonedPriorityDraftClient(input: { actorProfileId: string; updatedAt: string }) {
  const rootId = "eeeeeeee-eeee-4eee-8eee-000000000601";
  const authorityId = "18181818-1818-4818-8818-181818181818";
  const authorized = authorizeWorkplacePriorityDraft({
    schemaVersion: 1,
    baseRevision: 1,
    selections: { "601": "20", "602": "21", "603": "22" },
    selectedBy: { "601": ids.other, "602": ids.secondActor, "603": input.actorProfileId },
    updatedAt: input.updatedAt,
  }, {
    organizationId: ids.organization,
    rootQueueId: rootId,
  }, authorityId);
  const state = {
    auditInserts: [] as Array<Record<string, unknown>>,
    metadata: {
      dispatchRouting: {
        revision: 1,
        currentPlan: { "601": "20", "602": "21", "603": null },
      },
      workplacePriorityDraft: authorized.draft,
    } as Record<string, unknown>,
    updatedAt: "2026-08-07T07:50:01.000Z",
  };
  const draftAudit = {
    id: authorityId,
    actor_profile_id: input.actorProfileId,
    action: "telephony.workplace.priority.draft",
    entity_id: rootId,
    after_payload: authorized.auditPayload,
    created_at: input.updatedAt,
  };
  const client = {
    from: vi.fn((table: string) => query((calls) => {
      if (table === "motorist_telephony_queues") {
        const update = calls.find((call) => call.method === "update");
        if (!update) {
          return {
            data: {
              id: rootId,
              external_id: "601",
              metadata: state.metadata,
              updated_at: state.updatedAt,
            },
            error: null,
          };
        }
        if (eqValue(calls, "updated_at") !== state.updatedAt) return { data: null, error: null };
        state.metadata = jsonRecord(update.args[0]).metadata as Record<string, unknown>;
        state.updatedAt = "2026-08-07T08:00:01.000Z";
        return { data: { id: rootId, updated_at: state.updatedAt }, error: null };
      }
      if (table === "motorist_audit_log") {
        const insert = calls.find((call) => call.method === "insert");
        if (insert) {
          state.auditInserts.push(jsonRecord(insert.args[0]));
          return { data: null, error: null };
        }
        if (calls.some((call) => call.method === "maybeSingle")) {
          return { data: draftAudit, error: null };
        }
        return { data: [draftAudit], error: null };
      }
      throw new Error(`Unexpected abandoned-draft table ${table}`);
    })),
  };
  return { client, state };
}

function providerSnapshot(state: ProviderState = {}) {
  const extensions = state.omitEndpoint
    ? []
    : (["20", "21", "22", "23"] as const).map((extension) => ({
        extension,
        isRegistered: extension === (state.registeredExtension ?? "20") ? state.registered ?? false : false,
        allowedChanges: [],
        raw: {},
      }));
  const member = (extension: string) => ({
    extension,
    paused: extension === "20" ? state.paused ?? false : false,
    inUse: extension === "20" ? state.inUse ?? false : false,
    dynamic: true,
    callsTaken: 0,
  });
  return {
    capturedAt: state.capturedAt ?? now,
    extensions,
    activeCalls: state.activeCall
      ? [{ direction: "inbound" as const, status: "answered" as const, destinationExtension: "20", raw: {} }]
      : [],
    queueStatuses: [
      { queue: "601", members: state.offlineExtension === "20" ? [] : [member("20")], waitingCalls: state.waitingCalls ?? 0 },
      { queue: "602", members: state.offlineExtension === "21" ? [] : [member("21")], waitingCalls: 0 },
      { queue: "603", members: state.offlineExtension === "22" ? [] : [member("22")], waitingCalls: 0 },
    ],
  };
}

function operationRow(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: ids.operation,
    organization_id: ids.organization,
    idempotency_key: ids.operation,
    intent_hash: "intent",
    kind: "claim",
    actor_profile_id: ids.actor,
    source_profile_id: null,
    target_previous_profile_id: null,
    source_extension_id: null,
    target_extension_id: seatId("23"),
    source_lease_id: null,
    target_lease_id: null,
    browser_instance_id: ids.browser,
    expected_source_assignment_generation: null,
    expected_target_assignment_generation: generationId("23"),
    expected_source_lease_version: null,
    expected_target_lease_version: null,
    expected_source_heartbeat_at: null,
    expected_target_heartbeat_at: null,
    phase: "claimed",
    claim_generation: ids.claim,
    locked_at: now,
    claim_expires_at: "2026-08-07T08:01:30.000Z",
    provider_checked_at: null,
    provider_proof_hash: null,
    committed_at: null,
    completed_at: null,
    recovery_owner: null,
    recovery_expires_at: null,
    last_error_safe: null,
    result_safe: null,
    source_unassign_audit_id: null,
    target_unassign_audit_id: null,
    target_assign_audit_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function seatId(extension: string) {
  return `00000000-0000-4000-8000-0000000000${extension}`;
}

function generationId(extension: string) {
  return `cccccccc-cccc-4ccc-8ccc-cccccccccc${extension}`;
}

function leaseId(extension: string) {
  return `dddddddd-dddd-4ddd-8ddd-dddddddddd${extension}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function deriveResumeSecret(operationId: string, leaseIdValue: string, browserInstanceId: string) {
  return createHmac("sha256", resumeKey)
    .update("motorist.workplace.resume.v1\0")
    .update(operationId)
    .update("\0")
    .update(leaseIdValue)
    .update("\0")
    .update(browserInstanceId)
    .digest("base64url");
}
