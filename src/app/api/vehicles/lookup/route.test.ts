import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VehicleLookupResponse } from "@/lib/vehicle-lookup";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), lookup: vi.fn() }));
vi.mock("@/server/api-auth", async (original) => ({
  ...await original<typeof import("@/server/api-auth")>(),
  requireDefaultMotoristActor: mocks.actor,
}));
vi.mock("@/server/vehicle-lookup/service", async (original) => ({
  ...await original<typeof import("@/server/vehicle-lookup/service")>(),
  lookupVehicle: mocks.lookup,
}));
import { MutationError } from "@/server/motorist-mutations";
import { VehicleLookupError } from "@/server/vehicle-lookup/service";
import { POST } from "./route";

const endpoint = "https://dispatch.example.test/api/vehicles/lookup";
const input = { kind: "plate", value: "XX000XX", country: "SK" };
const result: VehicleLookupResponse = {
  cached: true,
  snapshot: { proof: "x".repeat(43), result: {
    version: 1, id: "cached-result", fetchedAt: "2026-09-05T08:00:00Z",
    query: { kind: "plate", value: "XX000XX", country: "SK", checkedForDate: "2026-09-05" },
    sources: [{ source: "skp", status: "found", fetchedAt: "2026-09-05T08:00:00Z", url: "https://www.skp.sk/", warnings: [], facts: { vin: { value: "WVWZZZ1JZXW000001", quality: "reported" } } }],
  } },
};
function request(body: unknown = input, origin = "https://dispatch.example.test") {
  return new Request(endpoint, { method: "POST", headers: { origin, host: "dispatch.example.test", "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
beforeEach(() => {
  mocks.actor.mockResolvedValue({ organizationId: "org-a", profileId: "dispatcher-a", role: "dispatcher" });
  mocks.lookup.mockResolvedValue(result);
});
afterEach(() => vi.resetAllMocks());

it("rejects a foreign Origin before auth or an external lookup", async () => {
  expect((await POST(request(input, "https://foreign.example.test"))).status).toBe(403);
  expect(mocks.actor).not.toHaveBeenCalled();
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it.each([401, 403])("does not query providers when the session or role is denied (%s)", async (status) => {
  mocks.actor.mockRejectedValue(new MutationError("Access denied", status));
  expect((await POST(request())).status).toBe(status);
  expect(mocks.actor).toHaveBeenCalledWith(["dispatcher", "senior_dispatcher", "manager", "admin"]);
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it("checks the current form VIN on every cache hit without changing the cached observation", async () => {
  const first = await POST(request({ ...input, knownIdentity: { vin: "WVWZZZ1JZXW000001" } }));
  const second = await POST(request({ ...input, knownIdentity: { vin: "WVWZZZ1JZXW000002" } }));
  expect(first.status).toBe(200);
  expect((await first.json()).conflict).toBeUndefined();
  const conflict = await second.json();
  expect(conflict.cached).toBe(true);
  expect(conflict.conflict).toMatch(/nesúhlasí/);
  expect(conflict.snapshot).toEqual(result.snapshot);
  expect(second.headers.get("Cache-Control")).toBe("private, no-store");
});
it("bounds the body and rejects malformed identifiers before calling a provider", async () => {
  expect((await POST(request({ ...input, padding: "x".repeat(2100) }))).status).toBe(413);
  expect((await POST(request({ ...input, kind: "vin", value: "not-a-vin" }))).status).toBe(400);
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it("preserves the shared limiter retry instruction", async () => {
  mocks.lookup.mockRejectedValue(new VehicleLookupError("Try later", 429, 60));
  const response = await POST(request());
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
});
