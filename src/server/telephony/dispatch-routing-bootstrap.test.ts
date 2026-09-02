import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdmin: vi.fn(),
  requestSnapshot: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.createAdmin }));
vi.mock("./provider-snapshot-bridge", () => ({ requestViptelProviderSnapshot: mocks.requestSnapshot }));

import {
  dispatchRoutingPreviewDigest,
  dispatchRoutingRootMetadataDigest,
  previewOrStartEmptyDispatchRoutingPlan,
} from "./dispatch-routing";
import { authorizeWorkplacePriorityDraft } from "./workplace-draft-authority";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  displayName: "Manager",
  role: "admin" as const,
};
const serviceSecret = "test-workplace-authority-secret-at-least-32-characters";
const authorityIdA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const authorityIdB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("empty dispatch bootstrap preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_SECRET_KEY = serviceSecret;
  });

  afterEach(() => delete process.env.SUPABASE_SECRET_KEY);

  it("produces the real 603 -> 602 -> 601 add plan without provider writes", async () => {
    const queues = queryResult({ data: dispatchQueues(), error: null });
    const routingHistory = queryResult({ data: [], error: null });
    const extensions = queryResult({ data: personalExtensions(), error: null });
    const pendingCommands = queryResult({ data: [], error: null });
    const client = sequentialClient([queues, routingHistory, extensions, pendingCommands]);
    const provider = emptyProvider();
    mocks.createAdmin.mockReturnValue(client);
    mocks.requestSnapshot.mockResolvedValue(await providerSnapshot(provider));

    const result = await previewOrStartEmptyDispatchRoutingPlan(actor, {
      baseRevision: 0,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: "21" },
        { queue: "603", extension: "22" },
      ],
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      preview: {
        baseRevision: 0,
        targetRevision: 1,
        initialBootstrap: true,
        fallback: { queue: "603", extension: "22" },
        steps: [
          { stepIndex: 0, action: "add", queue: "603", extension: "22" },
          { stepIndex: 1, action: "add", queue: "602", extension: "21" },
          { stepIndex: 2, action: "add", queue: "601", extension: "20" },
        ],
      },
      previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mocks.requestSnapshot).toHaveBeenCalledWith(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 });
    expect(client.from.mock.calls.map(([table]) => table)).toEqual([
      "motorist_telephony_queues",
      "motorist_audit_log",
      "motorist_telephony_extensions",
      "motorist_telephony_commands",
    ]);
    for (const query of [queues, routingHistory, extensions, pendingCommands]) {
      expect(query.calls.some((call) => ["insert", "update", "upsert", "delete"].includes(call.method))).toBe(false);
    }
  });

  it("previews a safe first activation with only the first operator selected", async () => {
    const queues = queryResult({ data: dispatchQueues(), error: null });
    const routingHistory = queryResult({ data: [], error: null });
    const extensions = queryResult({ data: personalExtensions(), error: null });
    const pendingCommands = queryResult({ data: [], error: null });
    const client = sequentialClient([queues, routingHistory, extensions, pendingCommands]);
    mocks.createAdmin.mockReturnValue(client);
    mocks.requestSnapshot.mockResolvedValue(await providerSnapshot(emptyProvider()));

    const result = await previewOrStartEmptyDispatchRoutingPlan(actor, {
      baseRevision: 0,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: null },
        { queue: "603", extension: null },
      ],
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      preview: {
        baseRevision: 0,
        targetRevision: 1,
        initialBootstrap: true,
        targetPlan: [
          { queue: "601", extension: "20" },
          { queue: "602", extension: null },
          { queue: "603", extension: null },
        ],
        fallback: { queue: "601", extension: "20" },
        steps: [
          { stepIndex: 0, action: "add", queue: "601", extension: "20" },
        ],
      },
      previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mocks.requestSnapshot).toHaveBeenCalledWith(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 });
  });

  it("previews two selected operators from the last safe anchor back to priority one", async () => {
    const queues = queryResult({ data: dispatchQueues(), error: null });
    const routingHistory = queryResult({ data: [], error: null });
    const extensions = queryResult({ data: personalExtensions(), error: null });
    const pendingCommands = queryResult({ data: [], error: null });
    const client = sequentialClient([queues, routingHistory, extensions, pendingCommands]);
    mocks.createAdmin.mockReturnValue(client);
    mocks.requestSnapshot.mockResolvedValue(await providerSnapshot(emptyProvider()));

    const result = await previewOrStartEmptyDispatchRoutingPlan(actor, {
      baseRevision: 0,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: "21" },
        { queue: "603", extension: null },
      ],
      dryRun: true,
    });

    expect(result.preview).toMatchObject({
      fallback: { queue: "602", extension: "21" },
      steps: [
        { stepIndex: 0, action: "add", queue: "602", extension: "21" },
        { stepIndex: 1, action: "add", queue: "601", extension: "20" },
      ],
    });
  });

  it("rejects an initial plan with a gap before any provider or database access", async () => {
    await expect(previewOrStartEmptyDispatchRoutingPlan(actor, {
      baseRevision: 0,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: null },
        { queue: "603", extension: "22" },
      ],
      dryRun: true,
    })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("súvislo od prvého radu 601"),
    });
    expect(mocks.createAdmin).not.toHaveBeenCalled();
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a repeated bootstrap from organization-wide immutable history before provider or extension reads", async () => {
    const queues = queryResult({ data: dispatchQueues(), error: null });
    const routingHistory = queryResult({
      data: [{ id: "historical-authority", action: "telephony.routing.operation.authorized" }],
      error: null,
    });
    const client = sequentialClient([queues, routingHistory]);
    mocks.createAdmin.mockReturnValue(client);

    await expect(previewOrStartEmptyDispatchRoutingPlan(actor, {
      baseRevision: 0,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: "21" },
        { queue: "603", extension: "22" },
      ],
      dryRun: true,
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("už bol v tejto organizácii použitý"),
    });

    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(client.from.mock.calls.map(([table]) => table)).toEqual([
      "motorist_telephony_queues",
      "motorist_audit_log",
    ]);
    expect(routingHistory.calls).toContainEqual({ method: "eq", args: ["organization_id", actor.organizationId] });
    expect(routingHistory.calls).toContainEqual({
      method: "in",
      args: ["action", ["telephony.routing.operation.authorized", "telephony.routing.plan.committed"]],
    });
    expect(routingHistory.calls.some((call) => call.method === "eq" && call.args[0] === "entity_id")).toBe(false);
  });

  it("accepts the exact canonical draft guard and exposes only its digest", async () => {
    const authorized = authorizedWorkplaceDraft("profile-a", authorityIdA);
    const draft = authorized.draft;
    const queues = queryResult({ data: dispatchQueues({ workplacePriorityDraft: draft }), error: null });
    const draftAuthority = queryResult({ data: [draftAuthorityRow(authorized, authorityIdA)], error: null });
    const routingHistory = queryResult({ data: [], error: null });
    const extensions = queryResult({ data: personalExtensions(), error: null });
    const pendingCommands = queryResult({ data: [], error: null });
    const client = sequentialClient([queues, draftAuthority, routingHistory, extensions, pendingCommands]);
    mocks.createAdmin.mockReturnValue(client);
    mocks.requestSnapshot.mockResolvedValue(await providerSnapshot(emptyProvider()));
    const rootMetadataGuard = {
      key: "workplacePriorityDraft" as const,
      digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", draft),
      authorityId: authorityIdA,
    };

    const result = await previewOrStartEmptyDispatchRoutingPlan(actor, {
      baseRevision: 0,
      slots: bootstrapSlots(),
      dryRun: true,
      rootMetadataGuard,
    });

    expect(result.preview).toMatchObject({ rootMetadataGuard });
    expect(JSON.stringify(result.preview)).not.toContain("profile-a");
    expect(queues.calls.some((call) => ["insert", "update", "upsert", "delete"].includes(call.method))).toBe(false);
  });

  it.each([true, false])("rejects a changed draft before %s routing without any operation write", async (dryRun) => {
    const reviewed = authorizedWorkplaceDraft("profile-a", authorityIdA).draft;
    const current = authorizedWorkplaceDraft("profile-b", authorityIdB).draft;
    const queues = queryResult({ data: dispatchQueues({ workplacePriorityDraft: current }), error: null });
    const client = sequentialClient([queues]);
    mocks.createAdmin.mockReturnValue(client);

    await expect(previewOrStartEmptyDispatchRoutingPlan(actor, {
      baseRevision: 0,
      slots: bootstrapSlots(),
      dryRun,
      previewDigest: dryRun ? undefined : "0".repeat(64),
      rootMetadataGuard: {
        key: "workplacePriorityDraft",
        digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", reviewed),
        authorityId: authorityIdA,
      },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("medzitým zmenil") });

    expect(client.from).toHaveBeenCalledTimes(1);
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(queues.calls.some((call) => ["insert", "update", "upsert", "delete"].includes(call.method))).toBe(false);
  });

  it("binds the reviewed preview digest to the exact draft guard", () => {
    const firstGuard = {
      key: "workplacePriorityDraft" as const,
      digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", workplaceDraft("profile-a")),
      authorityId: authorityIdA,
    };
    const secondGuard = {
      key: "workplacePriorityDraft" as const,
      digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", workplaceDraft("profile-b")),
      authorityId: authorityIdB,
    };
    const preview = {
      baseRevision: 0,
      targetRevision: 1,
      previousPlan: [
        { queue: "601" as const, extension: null },
        { queue: "602" as const, extension: null },
        { queue: "603" as const, extension: null },
      ],
      targetPlan: bootstrapSlots(),
      steps: [
        { stepIndex: 0, action: "add" as const, queue: "603" as const, extension: "22" },
        { stepIndex: 1, action: "add" as const, queue: "602" as const, extension: "21" },
        { stepIndex: 2, action: "add" as const, queue: "601" as const, extension: "20" },
      ],
      fallback: { queue: "603" as const, extension: "22" },
      initialBootstrap: true as const,
    };

    expect(dispatchRoutingPreviewDigest({ ...preview, rootMetadataGuard: firstGuard }))
      .not.toBe(dispatchRoutingPreviewDigest({ ...preview, rootMetadataGuard: secondGuard }));
  });

  it("canonicalizes JSONB object keys while preserving meaningful draft changes", () => {
    const draft = workplaceDraft("profile-a");
    const reordered = {
      updatedAt: draft.updatedAt,
      selectedBy: { "603": "profile-22", "601": "profile-a", "602": "profile-21" },
      selections: { "603": "22", "602": "21", "601": "20" },
      baseRevision: 0,
      schemaVersion: 1,
    };

    expect(dispatchRoutingRootMetadataDigest("workplacePriorityDraft", reordered))
      .toBe(dispatchRoutingRootMetadataDigest("workplacePriorityDraft", draft));
    expect(dispatchRoutingRootMetadataDigest("workplacePriorityDraft", {
      ...reordered,
      selections: { ...reordered.selections, "601": "23" },
    })).not.toBe(dispatchRoutingRootMetadataDigest("workplacePriorityDraft", draft));
  });
});

function dispatchQueues(rootMetadata: Record<string, unknown> = {}) {
  const labels = {
    "601": "Dispečing – prvá priorita",
    "602": "Dispečing – druhá priorita",
    "603": "Dispečing – tretia priorita / slučka",
  };
  return (["601", "602", "603"] as const).map((queue) => ({
    id: `queue-${queue}`,
    external_id: queue,
    label: labels[queue],
    line_id: null,
    active: true,
    metadata: queue === "601" ? rootMetadata : null,
    updated_at: "2026-08-05T00:00:00.000Z",
  }));
}

function bootstrapSlots() {
  return [
    { queue: "601" as const, extension: "20" },
    { queue: "602" as const, extension: "21" },
    { queue: "603" as const, extension: "22" },
  ];
}

function workplaceDraft(selectedBy: string) {
  return {
    schemaVersion: 1,
    baseRevision: 0,
    selections: { "601": "20", "602": "21", "603": "22" },
    selectedBy: { "601": selectedBy, "602": "profile-21", "603": "profile-22" },
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

function authorizedWorkplaceDraft(selectedBy: string, auditId: string) {
  return authorizeWorkplacePriorityDraft(
    workplaceDraft(selectedBy),
    { organizationId: actor.organizationId, rootQueueId: "queue-601" },
    auditId,
    { SUPABASE_SECRET_KEY: serviceSecret },
  );
}

function draftAuthorityRow(
  authorized: ReturnType<typeof authorizedWorkplaceDraft>,
  auditId: string,
) {
  return {
    id: auditId,
    action: "telephony.workplace.priority.draft",
    entity_id: "queue-601",
    after_payload: authorized.auditPayload,
    created_at: "2026-08-05T00:00:01.000Z",
  };
}

async function providerSnapshot(provider: ReturnType<typeof emptyProvider>) {
  return {
    extensions: await provider.listExtensions(),
    activeCalls: await provider.listActiveCalls(),
    queueStatuses: await Promise.all(["601", "602", "603"].map((queue) => provider.getQueueStatus(queue))),
  };
}

function personalExtensions() {
  return ["20", "21", "22"].map((extension, index) => ({
    id: `extension-${extension}`,
    extension,
    profile_id: `44444444-4444-4444-8444-44444444444${index}`,
    active: true,
    is_registered: true,
  }));
}

function emptyProvider() {
  return {
    listExtensions: vi.fn(async () => ["20", "21", "22"].map((extension) => ({
      extension,
      isRegistered: true,
      allowedChanges: [],
      raw: {},
    }))),
    listActiveCalls: vi.fn(async () => []),
    getQueueStatus: vi.fn(async (queue: string) => ({ queue, waitingCalls: 0, members: [] })),
  };
}

function sequentialClient(results: ReturnType<typeof queryResult>[]) {
  let index = 0;
  return { from: vi.fn((table: string) => {
    if (!table) throw new Error("Test query table is required.");
    return results[index++].query;
  }) };
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
