import { describe, expect, it } from "vitest";
import { acceptFleetPosition, fleetTelemetryDetails, isFreshFleetTimestamp, nextOccupancyObservation } from "./fleet-observation";
import { matchFleetIdentities, vinFromRegistration } from "./fleet-pairing";
import { fleetAvailability, occupancyText } from "./fleet-presentation";
import { fleetReconciliationCsv } from "./fleet-reconciliation";
import { computeLiveOccupancy } from "@/server/integrations/swhouse/live-occupancy";
import { fleetRefreshIsDue } from "@/server/integrations/fleet-refresh";
import { mergeFleetData } from "@/components/dispatch/useFleetRefresh";
import type { FleetAsset } from "@/domain/types";
import type { CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type { SwhouseCarOccupancyRaw } from "@/server/integrations/swhouse/types";

const now = Date.parse("2026-09-05T10:00:00Z");
const iso = (offset = 0) => new Date(now + offset).toISOString();
const car = (carId: number, ecv = `AA${carId}`, ownerTypeId = 3) => ({ carId, ecv, ownerTypeId } as SwhouseCarOccupancyRaw);

describe("live Software House occupancy", () => {
  it("joins live roster and free cars by stable carId, excluding non-fleet ownership", () => {
    const result = computeLiveOccupancy([car(1), car(2), car(3, "AA3", 9)], [car(1), car(3, "AA3", 9)], [3, 4]);
    expect(result.freePlates).toEqual(["AA1"]);
    expect(result.occupiedPlates).toEqual(["AA2"]);
    expect(result.states.get("2")).toBe("occupied");
  });
  it.each([
    [[car(1)], [car(2, "AA1")]],
    [[car(1)], [car(1, "DIFFERENT")]],
    [[car(1), car(2, "AA1")], []],
    [[car(1), car(1)], []],
    [[], []],
  ])("refuses ambiguous/inconsistent roster and free snapshots", (all, free) => {
    expect(() => computeLiveOccupancy(all, free, [3, 4])).toThrow();
  });
  it("does not fabricate a free car when the valid free list is empty", () => {
    expect(computeLiveOccupancy([car(1)], [], [3]).occupiedPlates).toEqual(["AA1"]);
  });
});

describe("fleet observation timestamps", () => {
  it("preserves the first observation only across a continuous same-state interval", () => {
    const previous = { state: "free", checkedAt: iso(-60_000), observedSince: iso(-180_000) };
    expect(nextOccupancyObservation(previous, "free", iso()).observedSince).toBe(iso(-180_000));
    expect(nextOccupancyObservation(previous, "occupied", iso()).observedSince).toBe(iso());
    expect(nextOccupancyObservation({ ...previous, checkedAt: iso(-660_000) }, "free", iso()).observedSince).toBe(iso());
    expect(nextOccupancyObservation({ ...previous, observedSince: iso(60_000) }, "free", iso()).observedSince).toBe(iso());
    expect(nextOccupancyObservation({ ...previous, checkedAt: iso(60_000) }, "free", iso()).observedSince).toBe(iso());
  });
  it("rejects old, missing and future freshness, independently from sync time", () => {
    expect(isFreshFleetTimestamp(iso(-60_000), now)).toBe(true);
    for (const value of [undefined, "bad", iso(-660_000), iso(120_000)]) expect(isFreshFleetTimestamp(value, now)).toBe(false);
  });
  it("never moves GPS backwards or substitutes a sync timestamp for a missing fix timestamp", () => {
    const point = { lat: 49.2, lng: 18.7 };
    expect(acceptFleetPosition(point, iso(), iso(-60_000), now)).toBe(true);
    expect(acceptFleetPosition(point, iso(-60_000), iso(), now)).toBe(false);
    expect(acceptFleetPosition(point, undefined, undefined, now)).toBe(false);
    expect(acceptFleetPosition(point, iso(120_000), undefined, now)).toBe(false);
    for (const bad of [{ lat: 0, lng: 0 }, { lat: 91, lng: 1 }, { lat: NaN, lng: 1 }]) expect(acceptFleetPosition(bad, iso(), undefined, now)).toBe(false);
  });
});

describe("conservative Commander identity matching", () => {
  const targets = [{ id: "swh1", plate: "AA 001 AB", vin: "VIN1" }, { id: "swh2", plate: "AA002AB", vin: "VIN2" }];
  it("matches exact normalized plates and exact VINs", () => {
    expect(matchFleetIdentities([{ id: "cmd1", plate: "aa-001ab" }], targets)).toEqual([{ sourceId: "cmd1", targetId: "swh1", method: "license_plate" }]);
    expect(matchFleetIdentities([{ id: "cmd1", vin: "VIN2" }], targets)[0].method).toBe("vin");
  });
  it("rejects duplicates on either side, conflicting identities and many-to-one matches", () => {
    expect(matchFleetIdentities([{ id: "a", plate: "AA001AB" }, { id: "b", plate: "AA001AB" }], targets)).toEqual([]);
    expect(matchFleetIdentities([{ id: "a", plate: "AA001AB" }], [...targets, { id: "swh3", plate: "AA001AB" }])).toEqual([]);
    expect(matchFleetIdentities([{ id: "a", plate: "AA001AB", vin: "VIN2" }], targets)).toEqual([]);
    expect(matchFleetIdentities([{ id: "a", plate: "AA001AB", vin: "CONFLICT" }], targets)).toEqual([]);
    expect(matchFleetIdentities([{ id: "a", plate: "AA001AB" }, { id: "b", vin: "VIN1" }], targets)).toEqual([]);
  });
  it("recognizes only complete 17-character VINs in Commander's registration field", () => {
    expect(vinFromRegistration("WVWZZZ1KZAW000001")).toBe("WVWZZZ1KZAW000001");
    expect(vinFromRegistration("VIN007477")).toBeNull();
    expect(vinFromRegistration("AA001AB")).toBeNull();
  });
});

describe("shared refresh and presentation safety", () => {
  it("exposes vehicle telemetry without provider authentication fields", () => {
    expect(fleetTelemetryDetails({ canRpm: 900, temperatures: [12, 20], token: "secret", Authorization: "secret" }))
      .toEqual({ canRpm: 900, temperatures: "[12,20]" });
  });
  it("waits for leases and throttles recent successful AND failed attempts", () => {
    expect(fleetRefreshIsDue({}, now)).toBe(true);
    expect(fleetRefreshIsDue({ leaseUntil: iso(60_000) }, now)).toBe(false);
    expect(fleetRefreshIsDue({ lastStartedAt: iso(-30_000), leaseUntil: null }, now)).toBe(false);
    expect(fleetRefreshIsDue({ lastStartedAt: iso(-360_000), leaseUntil: iso(-30_000) }, now)).toBe(true);
  });
  it("unknown/stale occupancy never looks free in a map popup", () => {
    const asset = { kind: "replacement_car", status: "available", occupancy: "stale" } as FleetAsset;
    expect(fleetAvailability(asset).label).toBe("Stav neaktuálny");
    expect(occupancyText(asset)).not.toContain("Voľné");
    expect(fleetAvailability({ ...asset, occupancy: "occupied" }).label).toBe("Obsadené");
  });
  it("merges fleet refresh without replacing newer cases or telephony data", () => {
    const current = { fleetAssets: [], dispatchCases: [{ id: "new-edit" }], callCenterCalls: [{ id: "new-call" }], integrations: [{ provider: "telnyx", status: "live" }] } as unknown as DispatchData;
    const incoming = { fleetAssets: [], dispatchCases: [], callCenterCalls: [], integrations: [{ provider: "client_vehicle_db", status: "live" }, { provider: "telnyx", status: "degraded" }] } as unknown as DispatchData;
    const next = mergeFleetData(current, incoming);
    expect(next.dispatchCases).toBe(current.dispatchCases);
    expect(next.callCenterCalls).toBe(current.callCenterCalls);
    expect(next.integrations).toEqual([{ provider: "telnyx", status: "live" }, { provider: "client_vehicle_db", status: "live" }]);
  });
  it("exports unimported Commander records and prevents spreadsheet formulas", () => {
    const source = { id: "cmd1", sourceActive: true, sourceVehicleId: "42", label: "=HYPERLINK(1)", licensePlate: "AA001AB" } as CommanderVehicleConnection;
    const csv = fleetReconciliationCsv([], [source]);
    expect(csv).toContain("Commander bez zhody");
    expect(csv).toContain("'=HYPERLINK(1)");
  });
});
