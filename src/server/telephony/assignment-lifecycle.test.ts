import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assignedLifecycle,
  assignmentProvisioningRequirement,
  readAssignmentLifecycle,
  requireImmutableWorkplaceSeatLifecycle,
  unassignedLifecycle,
} from "./assignment-lifecycle";

const organizationId = "11111111-1111-4111-8111-111111111111";
const extensionId = "22222222-2222-4222-8222-222222222222";

describe("assignment provisioning history", () => {
  it("records an explicit shared-workplace claim without pretending SIP rotation happened", () => {
    const lifecycle = assignedLifecycle({
      assignedAt: "2026-08-05T00:00:00.000Z",
      assignedBy: "66666666-6666-4666-8666-666666666666",
      assignmentMode: "workplace_claim",
      epoch: "44444444-4444-4444-8444-444444444444",
      extension: "20",
      extensionId,
      profileId: "55555555-5555-4555-8555-555555555555",
    });

    expect(readAssignmentLifecycle(lifecycle)).toEqual(lifecycle);
    expect(lifecycle.assignmentMode).toBe("workplace_claim");
  });

  it("requires rotation when an immutable audit for the same number uses an older row id", async () => {
    const history = result([{ ...auditRow("20"), entity_id: "33333333-3333-4333-8333-333333333333" }]);
    const client = { from: vi.fn(() => history.query) };

    await expect(requirement(client)).resolves.toBe("rotation_required");
    expect(history.calls).not.toContainEqual({ method: "eq", args: ["entity_id", extensionId] });
  });

  it("allows initial provisioning only when all bounded history belongs to other valid numbers", async () => {
    const client = { from: vi.fn(() => result([auditRow("21"), legacyAuditRow("22")]).query) };
    await expect(requirement(client)).resolves.toBe("initial_provisioning");
  });

  it("requires rotation for legacy same-number evidence without a lifecycle", async () => {
    const client = { from: vi.fn(() => result([legacyAuditRow("20")]).query) };
    await expect(requirement(client)).resolves.toBe("rotation_required");
  });

  it.each([
    ["query error", undefined, { message: "audit unavailable" }],
    ["malformed payload", [{ ...auditRow("20"), after_payload: { assignment_lifecycle: { extension: "20" } } }], null],
    ["ambiguous payload", [{ ...auditRow("21"), before_payload: { extension: "22" } }], null],
    ["scan overflow", Array.from({ length: 501 }, (_, index) => legacyAuditRow(String(1000 + index))), null],
  ])("fails closed on %s", async (_label, data, error) => {
    const client = { from: vi.fn(() => result(data, error).query) };
    await expect(requirement(client)).resolves.toBe("rotation_required");
  });

  it("treats local assignment metadata as rotation evidence without querying mutable history", async () => {
    const client = { from: vi.fn() };
    await expect(assignmentProvisioningRequirement(client as never, organizationId, {
      id: extensionId,
      extension: "20",
      profile_id: null,
      metadata: { assignmentQuarantine: { active: true } },
    })).resolves.toBe("rotation_required");
    expect(client.from).not.toHaveBeenCalled();
  });
});

describe("immutable hot-desk seat lifecycle", () => {
  const actorProfileId = "55555555-5555-4555-8555-555555555555";
  const assigned = assignedLifecycle({
    assignedAt: "2026-08-05T00:00:00.000Z",
    assignedBy: "66666666-6666-4666-8666-666666666666",
    assignmentMode: "workplace_claim",
    epoch: "44444444-4444-4444-8444-444444444444",
    extension: "20",
    extensionId,
    profileId: actorProfileId,
  });
  const unassigned = unassignedLifecycle(assigned, {
    unassignedAt: "2026-08-05T00:05:00.000Z",
    unassignedBy: actorProfileId,
  });

  it("accepts a free seat only when its unassign audit and empty reservation agree", async () => {
    const client = sequenceClient([
      {
        data: {
          id: "77777777-7777-4777-8777-777777777777",
          action: "telephony.extension.unassign",
          after_payload: { assignment_lifecycle: unassigned },
          created_at: "2026-08-05T00:05:00.000Z",
        },
        error: null,
      },
      { data: [], error: null },
    ]);

    await expect(requireImmutableWorkplaceSeatLifecycle(client as never, organizationId, {
      id: extensionId,
      extension: "20",
      profile_id: null,
      metadata: { assignmentLifecycle: unassigned },
    })).resolves.toEqual(unassigned);
  });

  it("fails closed when an apparently free seat still has a profile reservation", async () => {
    const client = sequenceClient([
      {
        data: {
          id: "77777777-7777-4777-8777-777777777777",
          action: "telephony.extension.unassign",
          after_payload: { assignment_lifecycle: unassigned },
          created_at: "2026-08-05T00:05:00.000Z",
        },
        error: null,
      },
      { data: [{ id: actorProfileId, phone_extension: "20" }], error: null },
    ]);

    await expect(requireImmutableWorkplaceSeatLifecycle(client as never, organizationId, {
      id: extensionId,
      extension: "20",
      profile_id: null,
      metadata: { assignmentLifecycle: unassigned },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("osirelú") });
  });
});

function requirement(client: { from: ReturnType<typeof vi.fn> }) {
  return assignmentProvisioningRequirement(client as never, organizationId, {
    id: extensionId,
    extension: "20",
    profile_id: null,
    metadata: {},
  });
}

function auditRow(extension: string) {
  return {
    id: crypto.randomUUID(),
    entity_id: crypto.randomUUID(),
    action: "telephony.extension.assign",
    before_payload: { extension },
    after_payload: {
      extension,
      assignment_lifecycle: {
        schemaVersion: 1,
        epoch: "44444444-4444-4444-8444-444444444444",
        state: "assigned",
        extensionId: "33333333-3333-4333-8333-333333333333",
        extension,
        profileId: "55555555-5555-4555-8555-555555555555",
        assignmentMode: "initial_provisioning",
        assignedAt: "2026-08-05T00:00:00.000Z",
        assignedBy: "66666666-6666-4666-8666-666666666666",
      },
    },
  };
}

function legacyAuditRow(extension: string) {
  return {
    id: crypto.randomUUID(),
    entity_id: crypto.randomUUID(),
    action: "telephony.extension.assignment_transition.recover",
    before_payload: null,
    after_payload: { extension },
  };
}

function result(data: unknown = [], error: unknown = null) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data, error }).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return query;
      };
    },
  });
  return { calls, query };
}

function sequenceClient(results: Array<{ data: unknown; error: unknown }>) {
  const queue = [...results];
  return {
    from: vi.fn(() => {
      const next = queue.shift();
      if (!next) throw new Error("Unexpected query");
      return result(next.data, next.error).query;
    }),
  };
}
