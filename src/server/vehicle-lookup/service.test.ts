import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
  vi.stubEnv("DATABAZA_VOZIDIEL_API_KEY", "");
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

it.each(["found", "unavailable"] as const)("uses STK's %s status for the healthy cache lifetime", async (status) => {
  mocks.rpc.mockResolvedValueOnce({ data: { status: "reserved", token: "lease", providers: { skp: true, stkonline: true, haka: true, vpic: true } }, error: null }).mockResolvedValue({ data: true, error: null });
  mocks.execute.mockResolvedValue({ ...result, sources: [
    { ...result.sources[0], status: "found" },
    { ...result.sources[1], status },
  ] } satisfies VehicleLookupResult);
  await lookupVehicle(query, actor);
  expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_success: status === "found", p_skp_failed: false });
});

it("keeps a short cache lifetime when a required provider result is missing", async () => {
  mocks.rpc.mockResolvedValueOnce({ data: { status: "reserved", token: "lease", providers: { skp: true, stkonline: true, haka: true, vpic: true } }, error: null }).mockResolvedValue({ data: true, error: null });
  mocks.execute.mockResolvedValue({ ...result, sources: [
    { ...result.sources[0], status: "found" },
  ] } satisfies VehicleLookupResult);
  await lookupVehicle(query, actor);
  expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_success: false });
});

it("enables the paid provider from server configuration without a database provider flag", async () => {
  vi.stubEnv("DATABAZA_VOZIDIEL_API_KEY", "server-side-test-key");
  mocks.rpc.mockResolvedValueOnce({ data: { status: "reserved", token: "lease", providers: { skp: true, stkonline: true, haka: true, vpic: true } }, error: null }).mockResolvedValue({ data: true, error: null });
  mocks.execute.mockResolvedValue(result);
  await lookupVehicle(query, actor);
  expect(mocks.execute).toHaveBeenCalledWith(query, { skp: true, stkonline: true, haka: true, vpic: true, databazavozidiel: true }, expect.any(Number));
  expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain("server-side-test-key");
});

it("does not trust a database paid-provider flag without a configured server key", async () => {
  vi.stubEnv("DATABAZA_VOZIDIEL_API_KEY", "   ");
  mocks.rpc.mockResolvedValueOnce({ data: { status: "reserved", token: "lease", providers: { skp: true, stkonline: true, haka: true, vpic: true, databazavozidiel: true } }, error: null }).mockResolvedValue({ data: true, error: null });
  mocks.execute.mockResolvedValue(result);
  await lookupVehicle(query, actor);
  expect(mocks.execute).toHaveBeenCalledWith(query, expect.objectContaining({ databazavozidiel: false }), expect.any(Number));
});

it("separates paid-provider configuration and invalidates pre-integration cache entries", async () => {
  mocks.rpc.mockResolvedValue({ data: { status: "cached", result }, error: null });
  await lookupVehicle(query, actor);
  vi.stubEnv("DATABAZA_VOZIDIEL_API_KEY", "server-side-test-key");
  await lookupVehicle(query, actor);
  const disabledHash = mocks.rpc.mock.calls[0][1].p_query_hash;
  const enabledHash = mocks.rpc.mock.calls[1][1].p_query_hash;
  expect(disabledHash).not.toBe(enabledHash);
  const previousHash = createHash("sha256").update(JSON.stringify([query.kind, query.value, query.country, query.checkedForDate, 3])).digest("hex");
  expect(disabledHash).not.toBe(previousHash);
  expect(enabledHash).not.toBe(previousHash);
});

it.each(["found", "not_found", "unavailable", "rate_limited", "ambiguous"] as const)("uses the registry's %s status for the healthy cache lifetime when enabled", async (status) => {
  vi.stubEnv("DATABAZA_VOZIDIEL_API_KEY", "server-side-test-key");
  mocks.rpc.mockResolvedValueOnce({ data: { status: "reserved", token: "lease", providers: { skp: true, stkonline: true, haka: true, vpic: true } }, error: null }).mockResolvedValue({ data: true, error: null });
  mocks.execute.mockResolvedValue({ ...result, sources: [
    { ...result.sources[0], status: "found" },
    { ...result.sources[1], status: "not_found" },
    { ...result.sources[1], source: "databazavozidiel", status, url: "https://www.databazavozidiel.sk/" },
  ] } satisfies VehicleLookupResult);
  await lookupVehicle(query, actor);
  expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_success: status === "found", p_skp_failed: false });
});

it.each(["unavailable", "conflicting_vin", "ambiguous"] as const)("keeps a short cache lifetime when a secondary provider returns %s", async (secondary) => {
  vi.stubEnv("DATABAZA_VOZIDIEL_API_KEY", "server-side-test-key");
  mocks.rpc.mockResolvedValueOnce({ data: { status: "reserved", token: "lease", providers: { skp: true, stkonline: true, haka: true, vpic: true } }, error: null }).mockResolvedValue({ data: true, error: null });
  mocks.execute.mockResolvedValue({ ...result, sources: [
    { ...result.sources[0], status: "found" },
    { ...result.sources[1], status: secondary === "conflicting_vin" ? "found" : secondary, facts: { vin: { value: "WVWZZZ1JZXW000002", quality: "reported" } } },
    { ...result.sources[1], source: "databazavozidiel", status: "found", url: "https://www.databazavozidiel.sk/" },
  ] } satisfies VehicleLookupResult);
  await lookupVehicle(query, actor);
  expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_success: false });
});

it("keeps a short cache lifetime when the enabled registry result is missing", async () => {
  vi.stubEnv("DATABAZA_VOZIDIEL_API_KEY", "server-side-test-key");
  mocks.rpc.mockResolvedValueOnce({ data: { status: "reserved", token: "lease", providers: { skp: true, stkonline: true, haka: true, vpic: true } }, error: null }).mockResolvedValue({ data: true, error: null });
  mocks.execute.mockResolvedValue({ ...result, sources: [{ ...result.sources[0], status: "found" }, result.sources[1]] });
  await lookupVehicle(query, actor);
  expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_success: false });
});
