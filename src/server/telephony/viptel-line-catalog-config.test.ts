import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  assertGate: vi.fn(),
  createAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.createAdmin }));
vi.mock("./live-mutation-gate", () => ({ assertTelephonyLiveMutationEnabled: mocks.assertGate }));

import { MutationError } from "@/server/motorist-mutations";
import { configureViptelLineCatalog, planViptelLineCatalogConfiguration } from "./viptel-line-catalog-config";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VIPTel line catalog configuration plan", () => {
  it("plans the nine approved catalog numbers and never invents missing 9246", () => {
    const plan = planViptelLineCatalogConfiguration([]);

    expect(plan).toHaveLength(9);
    expect(plan.every((item) => item.action === "insert")).toBe(true);
    expect(plan.map((item) => item.phoneNumber)).not.toContain("0412289246");
    expect(plan.find((item) => item.phoneNumber === "0412289241")?.label).toBe("Allianz Assistance");
    expect(plan.find((item) => item.phoneNumber === "0412289247")?.label).toBe("LeasePlan Slovakia s.r.o.");
  });

  it("is idempotent for exact active rows and repairs labels/formatting without duplicating them", () => {
    const plan = planViptelLineCatalogConfiguration([
      {
        id: "line-240",
        external_id: "0412289240",
        phone_number: "0412289240",
        label: "Neutrálna linka",
        active: true,
      },
      {
        id: "line-241",
        external_id: null,
        phone_number: "+421 41 228 9241",
        label: "Stará Allianz",
        active: false,
      },
    ]);

    expect(plan.find((item) => item.phoneNumber === "0412289240")).toMatchObject({ action: "noop", existingId: "line-240" });
    expect(plan.find((item) => item.phoneNumber === "0412289241")).toMatchObject({ action: "update", existingId: "line-241" });
  });

  it("fails closed on two canonical-equivalent rows", () => {
    const plan = planViptelLineCatalogConfiguration([
      { id: "a", external_id: null, phone_number: "0412289242", label: "A", active: true },
      { id: "b", external_id: null, phone_number: "+421412289242", label: "B", active: true },
    ]);

    expect(plan.find((item) => item.phoneNumber === "0412289242")).toMatchObject({ action: "conflict" });
  });

  it("marks both canonical entries conflicted when one row cross-links their public numbers", () => {
    const plan = planViptelLineCatalogConfiguration([
      { id: "cross", external_id: "0412289242", phone_number: "0412289241", label: "ambiguous", active: true },
    ]);

    expect(plan.find((item) => item.phoneNumber === "0412289241")).toMatchObject({ action: "conflict" });
    expect(plan.find((item) => item.phoneNumber === "0412289242")).toMatchObject({ action: "conflict" });
  });

  it("keeps apply write-free when the live gate is disabled", async () => {
    const lookup = queryResult({ data: [], error: null });
    const from = vi.fn(() => lookup.query);
    mocks.createAdmin.mockReturnValue({ from });
    mocks.assertGate.mockImplementation(() => {
      throw new MutationError("live gate disabled", 503);
    });

    await expect(configureViptelLineCatalog({
      userId: "user",
      profileId: "profile",
      organizationId: "organization",
      displayName: "Manager",
      role: "manager",
    }, false)).rejects.toMatchObject({ status: 503 });

    expect(mocks.assertGate).toHaveBeenCalledWith("dispatch.lines.catalog.apply");
    expect(from).toHaveBeenCalledTimes(1);
    expect(lookup.calls.some((call) => call.method === "insert" || call.method === "update")).toBe(false);
  });
});

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
        return query;
      };
    },
  });
  return { calls, query };
}
