import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupSnapshotForSave, readVerifiedVehicleLookup, sealVehicleLookup, verifyVehicleLookup } from "./snapshot";
import type { VehicleLookupResult } from "@/lib/vehicle-lookup";

const vin = "WVWZZZ1JZXW000001";
const result: VehicleLookupResult = { version: 1, id: "test", query: { kind: "vin", value: vin, country: "SK", checkedForDate: "2026-09-05" }, fetchedAt: "2026-09-05T08:00:00Z", sources: [{ source: "vpic", status: "found", url: "https://vpic.nhtsa.dot.gov/api/", fetchedAt: "2026-09-05T08:00:00Z", facts: { make: { value: "TESLA", quality: "partial" } }, warnings: [] }] };
afterEach(() => vi.unstubAllEnvs());
describe("durable signed vehicle observations", () => {
  it("survives JSONB key reordering and cache expiry without changing fetched time", () => {
    vi.stubEnv("VEHICLE_LOOKUP_SIGNING_KEY", "test-only-signing-key");
    const snapshot = sealVehicleLookup(result, "org-a");
    const reordered = { ...snapshot, result: { sources: result.sources, fetchedAt: result.fetchedAt, query: result.query, id: result.id, version: 1 as const } };
    vi.useFakeTimers(); vi.setSystemTime(new Date("2027-03-01"));
    expect(verifyVehicleLookup(reordered, "org-a", { vin })?.result.fetchedAt).toBe(result.fetchedAt);
    vi.useRealTimers();
  });
  it("rejects modification, cross-org reuse, query identity change, and forged existing DB metadata", () => {
    vi.stubEnv("VEHICLE_LOOKUP_SIGNING_KEY", "test-only-signing-key");
    const snapshot = sealVehicleLookup(result, "org-a");
    expect(() => verifyVehicleLookup(snapshot, "org-b", { vin })).toThrow();
    expect(() => verifyVehicleLookup(snapshot, "org-a", { vin: "WVWZZZ1JZXW000002" })).toThrow();
    const forged = { ...snapshot, result: { ...result, fetchedAt: "2028-01-01T00:00:00Z" } };
    expect(() => lookupSnapshotForSave({ vehicleLookup: forged, vin }, "org-a", { identity: { vin }, snapshot: forged })).toThrow();
    expect(readVerifiedVehicleLookup(forged, "org-a", { vin })).toBeUndefined();
    expect(readVerifiedVehicleLookup(snapshot, "org-a", { vin })?.proof).toBe(snapshot.proof);
  });
  it("detaches old provenance when a caller changes identity without a replacement snapshot", () => {
    const previous = sealVehicleLookup(result, "org-a", "test");
    expect(lookupSnapshotForSave({ vin: "WVWZZZ1JZXW000002" }, "org-a", { identity: { vin }, snapshot: previous })).toBeNull();
    expect(lookupSnapshotForSave({ vin }, "org-a", { identity: { vin }, snapshot: previous })).toBeUndefined();
  });
});
