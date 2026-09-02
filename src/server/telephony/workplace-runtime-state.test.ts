import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  findBootstrappedWorkplaceExtensionIds,
  isMissingWorkplaceSchemaMarkerError,
  loadBootstrappedWorkplaceExtensions,
} from "./workplace-runtime-state";

const organizationId = "11111111-1111-4111-8111-111111111111";
const extensionId = "22222222-2222-4222-8222-222222222222";
const generation = "33333333-3333-4333-8333-333333333333";

describe("workplace runtime schema marker", () => {
  it("preserves the pre-migration seat-20 path only for the exact missing-column response", async () => {
    const client = clientResult({
      data: null,
      error: {
        code: "PGRST204",
        message: "Could not find the 'workplace_seat_generation' column in the schema cache",
      },
    });

    await expect(findBootstrappedWorkplaceExtensionIds(client as never, organizationId, {
      extensions: ["20"],
    })).resolves.toEqual(new Set());
    expect(isMissingWorkplaceSchemaMarkerError({
      code: "42703",
      message: 'column "workplace_seat_generation" does not exist',
    })).toBe(true);
  });

  it("fails closed for an unrelated marker read error", async () => {
    const client = clientResult({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(findBootstrappedWorkplaceExtensionIds(client as never, organizationId, {
      extensionIds: [extensionId],
    })).rejects.toMatchObject({ status: 500 });
  });

  it("returns the exact stable generation only for bootstrapped seats", async () => {
    const client = clientResult({
      data: [
        { id: extensionId, workplace_seat_generation: generation },
        { id: "44444444-4444-4444-8444-444444444444", workplace_seat_generation: null },
      ],
      error: null,
    });
    await expect(loadBootstrappedWorkplaceExtensions(client as never, organizationId, {
      extensions: ["20", "21"],
    })).resolves.toEqual(new Map([[extensionId, generation]]));
  });
});

function clientResult(result: { data: unknown; error: unknown }) {
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      return () => query;
    },
  });
  return { from: vi.fn(() => query) };
}
