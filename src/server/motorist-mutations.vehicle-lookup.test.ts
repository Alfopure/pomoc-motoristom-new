import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VehicleLookupResult } from "@/lib/vehicle-lookup";

const state = vi.hoisted(() => ({ asset: {} as Record<string, unknown>, updates: [] as Record<string, unknown>[] }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ from: (table: string) => query(table) }) }));
function query(table: string) {
  const result = () => ({ error: null, data: table === "motorist_organizations" ? { id: "test-org", active: true } : table === "motorist_fleet_assets" ? state.asset : { id: "test-audit" } });
  const chain = {
    select: () => chain, eq: () => chain, insert: () => chain,
    update: (payload: Record<string, unknown>) => {
      state.updates.push(payload);
      // Simulate the persisted JSON, not the identity of the submitted JS object.
      state.asset = JSON.parse(JSON.stringify({ ...state.asset, ...payload }));
      return chain;
    },
    maybeSingle: async () => result(), single: async () => result(),
  };
  return chain;
}
import { updateFleetAsset } from "./motorist-mutations";
import { readVerifiedVehicleLookup, sealVehicleLookup } from "./vehicle-lookup/snapshot";

const vin = "WVWZZZ1JZXW000001";
const plate = "XX000XX";
const result: VehicleLookupResult = { version: 1, id: "test-result", query: { kind: "plate", value: plate, country: "SK", checkedForDate: "2026-09-05" }, fetchedAt: "2026-09-05T08:00:00Z", sources: [{ source: "skp", status: "found", url: "https://www.skp.sk/", fetchedAt: "2026-09-05T08:00:00Z", warnings: [], facts: { vin: { value: vin, quality: "reported" }, plate: { value: plate, quality: "reported" } } }] };
beforeEach(() => {
  vi.stubEnv("VEHICLE_LOOKUP_SIGNING_KEY", "test-only-signing-key");
  state.updates = [];
  state.asset = { id: "test-fleet", organization_id: "test-org", license_plate: plate, vin, current_location_id: null, label: "Synthetic fleet", status: "available", metadata: { availabilityUnverified: true, providerMetadata: { preserve: true } } };
});
afterEach(() => vi.unstubAllEnvs());

it.each([true, false])("preserves an accepted lookup through a status save and verified JSON read (unverified=%s)", async (unverified) => {
  state.asset.metadata = { availabilityUnverified: unverified, providerMetadata: { preserve: true } };
  const snapshot = sealVehicleLookup(result, "test-org");
  await updateFleetAsset("test-fleet", { status: "available", vehicleLookup: snapshot });
  const metadata = state.asset.metadata as Record<string, unknown>;
  expect(metadata).toMatchObject({ availabilityUnverified: false, providerMetadata: { preserve: true } });
  expect(readVerifiedVehicleLookup(metadata.vehicleLookup, "test-org", { plate, vin })).toEqual(snapshot);
});
it("clears an explicitly detached lookup while confirming availability", async () => {
  state.asset.metadata = { availabilityUnverified: true, vehicleLookup: sealVehicleLookup(result, "test-org") };
  await updateFleetAsset("test-fleet", { status: "available", vehicleLookup: null });
  expect(state.asset.metadata).toEqual({ availabilityUnverified: false, vehicleLookup: null });
});
it("detaches a lookup on identity change even when status is saved simultaneously", async () => {
  state.asset.metadata = { availabilityUnverified: true, vehicleLookup: sealVehicleLookup(result, "test-org") };
  await updateFleetAsset("test-fleet", { status: "available", licensePlate: "XX000XY" });
  expect(state.asset.metadata).toEqual({ availabilityUnverified: false, vehicleLookup: null });
});
it("keeps an existing lookup when availability alone is confirmed", async () => {
  const snapshot = sealVehicleLookup(result, "test-org");
  state.asset.metadata = { availabilityUnverified: true, vehicleLookup: snapshot };
  await updateFleetAsset("test-fleet", { status: "available" });
  expect(state.asset.metadata).toEqual({ availabilityUnverified: false, vehicleLookup: snapshot });
});
it("does not write metadata for an unrelated edit", async () => {
  await updateFleetAsset("test-fleet", { label: "Updated label" });
  expect(state.updates[0]).not.toHaveProperty("metadata");
});
