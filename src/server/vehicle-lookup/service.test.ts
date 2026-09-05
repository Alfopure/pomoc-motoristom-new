import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), execute: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("./execute", () => ({ executeVehicleLookup: mocks.execute }));
import { lookupVehicle } from "./service";
import type { MotoristActor } from "@/server/api-auth";
import type { VehicleLookupResult, VehicleQuery } from "@/lib/vehicle-lookup";
const actor = { organizationId: "org-a", profileId: "profile-a" } as MotoristActor;
const query: VehicleQuery = { kind: "plate", value: "XX000XX", country: "SK", checkedForDate: "2026-09-05" };
const result: VehicleLookupResult = { version: 1, id: "test", query, fetchedAt: "2026-09-05T08:00:00Z", sources: [{ source: "skp", status: "unsupported", facts: {}, fetchedAt: "2026-09-05T08:00:00Z", url: "https://www.skp.sk/", warnings: [] }, { source: "stkonline", status: "found", facts: { vin: { value: "WVWZZZ1JZXW000001", quality: "reported" } }, fetchedAt: "2026-09-05T08:00:00Z", url: "https://www.stkonline.sk/", warnings: [] }] };
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co"); vi.stubEnv("SUPABASE_ANON_KEY", "test"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test"); vi.stubEnv("VEHICLE_LOOKUP_SIGNING_KEY", "test");
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
it.each(["pending", "disabled", "rate_limited"])("does not send providers when durable coordination returns %s", async (status) => {
  mocks.rpc.mockResolvedValue({ data: { status }, error: null });
  await expect(lookupVehicle(query, actor)).rejects.toThrow(); expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_organization_id: "org-a", p_profile_id: "profile-a" });
});
it("fails closed when the coordination database is unavailable", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });
  await expect(lookupVehicle(query, actor)).rejects.toThrow(); expect(mocks.execute).not.toHaveBeenCalled();
});
it("returns cached observations without outbound requests", async () => {
  mocks.rpc.mockResolvedValue({ data: { status: "cached", result }, error: null });
  expect((await lookupVehicle(query, actor)).cached).toBe(true); expect(mocks.execute).not.toHaveBeenCalled();
});
it("keeps STK facts on a skipped SKP circuit but uses the short partial-result cache lifetime", async () => {
  mocks.rpc.mockResolvedValueOnce({ data: { status: "reserved", token: "lease", providers: { skp: false, stkonline: true, haka: true, vpic: true } }, error: null }).mockResolvedValue({ data: true, error: null });
  mocks.execute.mockResolvedValue(result);
  const response = await lookupVehicle(query, actor);
  expect(response.snapshot.result.sources[1].facts.vin?.value).toBe("WVWZZZ1JZXW000001");
  expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_token: "lease", p_success: false, p_skp_failed: null });
});
