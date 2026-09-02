import { describe, expect, it } from "vitest";

import { computeOccupancyFromRoster } from "./occupancy-sync";
import {
  deriveReplacementOccupancy,
  isOccupancySnapshotStale,
  isOccupiedAssignmentBlocked,
  isUnverifiedAssignmentBlocked,
  OCCUPANCY_STALE_AFTER_MINUTES,
  type OccupancySnapshot,
} from "./occupancy-snapshot";
import type { SwhouseCarOccupancyRaw } from "./types";

const NOW = Date.parse("2026-07-10T12:00:00Z");

function freshSnapshot(overrides?: Partial<OccupancySnapshot>): OccupancySnapshot {
  return {
    capturedAt: new Date(NOW - 60_000).toISOString(), // 1 min staré → čerstvé
    occupiedPlates: new Set(["ZA141HM"]),
    freePlates: new Set(["AA010HN"]),
    ...overrides,
  };
}

describe("deriveReplacementOccupancy — štyri stavy (T2)", () => {
  it("occupied: ŠPZ v occupiedPlates", () => {
    expect(deriveReplacementOccupancy(freshSnapshot(), "za 141 hm", NOW)).toBe("occupied");
  });

  it("free: ŠPZ vo freePlates", () => {
    expect(deriveReplacementOccupancy(freshSnapshot(), "AA010HN", NOW)).toBe("free");
  });

  it("unverified: ŠPZ, ktorú SWHouse nepozná (ani free ani occupied)", () => {
    expect(deriveReplacementOccupancy(freshSnapshot(), "BL999XX", NOW)).toBe("unverified");
  });

  it("unverified: prázdna/chýbajúca ŠPZ pri čerstvom snapshote", () => {
    expect(deriveReplacementOccupancy(freshSnapshot(), null, NOW)).toBe("unverified");
    expect(deriveReplacementOccupancy(freshSnapshot(), "-", NOW)).toBe("unverified");
  });

  it("stale: snapshot starší než prah → stale pre všetky (aj známe ŠPZ)", () => {
    const old = freshSnapshot({ capturedAt: new Date(NOW - (OCCUPANCY_STALE_AFTER_MINUTES + 1) * 60_000).toISOString() });
    expect(deriveReplacementOccupancy(old, "ZA141HM", NOW)).toBe("stale");
    expect(deriveReplacementOccupancy(old, "AA010HN", NOW)).toBe("stale");
  });

  it("stale: chýbajúci snapshot → stale", () => {
    expect(deriveReplacementOccupancy(null, "ZA141HM", NOW)).toBe("stale");
  });
});

describe("isOccupancySnapshotStale", () => {
  it("null / nevalidný / starý → stale; čerstvý → nie", () => {
    expect(isOccupancySnapshotStale(null, NOW)).toBe(true);
    expect(isOccupancySnapshotStale(freshSnapshot({ capturedAt: "nonsense" }), NOW)).toBe(true);
    expect(isOccupancySnapshotStale(freshSnapshot(), NOW)).toBe(false);
  });
});

describe("isOccupiedAssignmentBlocked — assignCase guard (T2)", () => {
  it("blokuje occupied bez override", () => {
    expect(isOccupiedAssignmentBlocked("occupied", false)).toBe(true);
  });
  it("povolí occupied s override", () => {
    expect(isOccupiedAssignmentBlocked("occupied", true)).toBe(false);
  });
  it("occupied guard neblokuje ostatné stavy", () => {
    expect(isOccupiedAssignmentBlocked("free", false)).toBe(false);
    expect(isOccupiedAssignmentBlocked("unverified", false)).toBe(false);
    expect(isOccupiedAssignmentBlocked("stale", false)).toBe(false);
  });
  it("vyžaduje explicitné potvrdenie pri stale/unverified/undefined", () => {
    for (const occupancy of ["unverified", "stale", undefined] as const) {
      expect(isUnverifiedAssignmentBlocked(occupancy, false)).toBe(true);
      expect(isUnverifiedAssignmentBlocked(occupancy, true)).toBe(false);
    }
    expect(isUnverifiedAssignmentBlocked("free", false)).toBe(false);
    expect(isUnverifiedAssignmentBlocked("occupied", false)).toBe(false);
  });
});

describe("computeOccupancyFromRoster — obsadené = roster mínus voľné (T2, oddelené od getCars)", () => {
  const freeRaw: SwhouseCarOccupancyRaw[] = [
    { carId: 8772, manufacturerId: 1, colorId: 11, model: "A6", ecv: "aa 010-hn", vin: "WAUZ", cotp: null, typeId: 1, ownerTypeId: 3, lasFilialId: 1, rentId: 1, assistanceRentId: null, rentTo: null },
    { carId: 9999, manufacturerId: 1, colorId: 11, model: "Cudzie", ecv: "BL999XX", vin: "X", cotp: null, typeId: 1, ownerTypeId: 9, lasFilialId: 1, rentId: 1, assistanceRentId: null, rentTo: null },
  ];
  const rosterPlates = ["AA010HN", "ZA141HM", "ZA 226 JD"]; // roster z DB (client_vehicle_db)

  it("voľné = SWHouse free; obsadené = roster mínus free (normalizované)", () => {
    const result = computeOccupancyFromRoster(freeRaw, rosterPlates, [3, 4]);
    expect(result.freePlates).toEqual(["AA010HN"]);
    expect(result.occupiedPlates).toEqual(["ZA141HM", "ZA226JD"]);
  });

  it("cudzie owner typy ani ŠPZ mimo rosteru neoznačí ako overene voľné", () => {
    const result = computeOccupancyFromRoster(freeRaw, ["AA010HN", "BL999XX"], [3, 4]);
    expect(result.freePlates).toEqual(["AA010HN"]);
    expect(result.occupiedPlates).toEqual(["BL999XX"]);
  });

  it("prázdny roster → žiadne obsadené (nenafabrikuje obsadenosť)", () => {
    const result = computeOccupancyFromRoster(freeRaw, [], [3, 4]);
    expect(result.freePlates).toEqual([]);
    expect(result.occupiedPlates).toEqual([]);
  });
});
