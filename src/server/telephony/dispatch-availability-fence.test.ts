import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createAdmin: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.createAdmin }));

import { assertNoPendingDispatchAvailabilityCommand } from "./dispatch-routing";

const organizationId = "11111111-1111-4111-8111-111111111111";

/**
 * The fence that stops two availability changes racing. It is checked on the
 * operator's own "Dostupný", so anything it treats as a conflict becomes an
 * error in front of a person.
 */
function adminReturning(rows: Array<{ id: string; request_payload: unknown }>) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => builder };
}

beforeEach(() => {
  mocks.createAdmin.mockReset();
});

describe("pending availability fence", () => {
  it("passes when nothing is in flight", async () => {
    mocks.createAdmin.mockReturnValue(adminReturning([]));
    await expect(assertNoPendingDispatchAvailabilityCommand(organizationId, "601", "20")).resolves.toBeUndefined();
  });

  it("still blocks a manager routing command on the same queue", async () => {
    mocks.createAdmin.mockReturnValue(adminReturning([
      { id: "cmd-1", request_payload: { queue: "601", extension: "21", action: "add" } },
    ]));
    await expect(assertNoPendingDispatchAvailabilityCommand(organizationId, "601", "20"))
      .rejects.toThrow("Predchádzajúca zmena dostupnosti ešte nie je potvrdená.");
  });

  it("still blocks another change to the same extension", async () => {
    mocks.createAdmin.mockReturnValue(adminReturning([
      { id: "cmd-2", request_payload: { queue: "603", extension: "20", action: "add" } },
    ]));
    await expect(assertNoPendingDispatchAvailabilityCommand(organizationId, "601", "20"))
      .rejects.toThrow("Predchádzajúca zmena dostupnosti ešte nie je potvrdená.");
  });

  it("lets an operator go available while coverage is packing them into the other queues", async () => {
    // The reconciler adds a newly online operator to the remaining queues within
    // seconds of them joining the first one. Those in-flight adds used to block
    // the operator's own availability call, so every seat takeover reported
    // "Predchádzajúca zmena dostupnosti ešte nie je potvrdená" even though the
    // membership it was waiting for was already being created.
    mocks.createAdmin.mockReturnValue(adminReturning([
      {
        id: "cmd-3",
        request_payload: {
          queue: "602",
          extension: "20",
          action: "add",
          routingCoverage: { kind: "coverage", planRevision: 9, desiredDigest: "601:20|602:20|603:20" },
        },
      },
      {
        id: "cmd-4",
        request_payload: {
          queue: "603",
          extension: "20",
          action: "add",
          routingCoverage: { kind: "coverage", planRevision: 9, desiredDigest: "601:20|602:20|603:20" },
        },
      },
    ]));
    await expect(assertNoPendingDispatchAvailabilityCommand(organizationId, "601", "20")).resolves.toBeUndefined();
  });

  it("blocks a coverage removal, which is the conflicting direction", async () => {
    // Coverage taking the extension out of a queue genuinely contradicts the
    // operator asking to be in one, so this one must still fail closed.
    mocks.createAdmin.mockReturnValue(adminReturning([
      {
        id: "cmd-5",
        request_payload: {
          queue: "602",
          extension: "20",
          action: "remove",
          routingCoverage: { kind: "coverage", planRevision: 9, desiredDigest: "601:|602:|603:" },
        },
      },
    ]));
    await expect(assertNoPendingDispatchAvailabilityCommand(organizationId, "601", "20"))
      .rejects.toThrow("Predchádzajúca zmena dostupnosti ešte nie je potvrdená.");
  });

  it("does not accept an add that merely claims to be coverage-shaped", async () => {
    // Only a real coverage tag is exempt; an untagged add on the same queue is
    // still somebody else's change.
    mocks.createAdmin.mockReturnValue(adminReturning([
      { id: "cmd-6", request_payload: { queue: "601", extension: "20", action: "add", routingCoverage: {} } },
    ]));
    await expect(assertNoPendingDispatchAvailabilityCommand(organizationId, "601", "20"))
      .rejects.toThrow("Predchádzajúca zmena dostupnosti ešte nie je potvrdená.");
  });
});
