import "server-only";

import { mapSwhouseBranch } from "./branch-mapping";
import { SwhouseClient } from "./client";
import { getCodelistMaps, type SwhouseCodelistMaps } from "./codelists";
import { swhouseConfigFromEnv, type SwhouseConfig } from "./config";
import type {
  SwhouseAvailability,
  SwhouseCarOccupancyRaw,
  SwhouseCarRaw,
  SwhouseFleetOccupancy,
  SwhouseReplacementVehicle,
} from "./types";

const EMPTY_MAPS: SwhouseCodelistMaps = {
  manufacturers: new Map(),
  colors: new Map(),
  carTypes: new Map(),
  ownerTypes: new Map(),
  branches: new Map(),
  expiresAt: 0,
};

/** Surové voľné vozidlá → normalizovaný tvar (durable pre fázu 2). Preskočí placeholder carId 0. */
export function normalizeOccupancy(
  raw: SwhouseCarOccupancyRaw[],
  maps: SwhouseCodelistMaps,
  branchMap: Record<string, string>,
): SwhouseReplacementVehicle[] {
  const vehicles: SwhouseReplacementVehicle[] = [];
  for (const car of raw) {
    if (!car || typeof car.carId !== "number" || car.carId <= 0) {
      continue;
    }
    vehicles.push({
      carId: car.carId,
      ecv: car.ecv ?? "",
      vin: car.vin ?? "",
      make: maps.manufacturers.get(car.manufacturerId) ?? null,
      model: car.model ?? "",
      color: maps.colors.get(car.colorId) ?? null,
      ownerType: maps.ownerTypes.get(car.ownerTypeId) ?? null,
      kindHint: "replacement_car",
      swhouseBranchId: car.lasFilialId ?? null,
      swhouseBranchName: car.lasFilialId != null ? maps.branches.get(car.lasFilialId) ?? null : null,
      branchInternalId: mapSwhouseBranch(branchMap, car.lasFilialId ?? null),
      rentTo: car.rentTo ?? null,
      details: vehicleDetails(car),
    });
  }
  return vehicles;
}

/** Normalizácia ŠPZ na párovanie: uppercase, len A-Z0-9 (SWHouse aj Commander píšu rôzne formáty). */
export function normalizePlateForPairing(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Jedno auto z getCars (celá flotila, nielen voľné) → normalizovaný tvar pre Fázu 2 (roster do DB).
 * Na rozdiel od normalizeOccupancy tu nemáme rentTo (stav rieši živý occupancy overlay). Vráti null pre placeholder.
 */
export function normalizeFleetCar(
  car: SwhouseCarRaw,
  maps: SwhouseCodelistMaps,
  branchMap: Record<string, string>,
): SwhouseReplacementVehicle | null {
  if (!car || typeof car.carId !== "number" || car.carId <= 0) {
    return null;
  }
  return {
    carId: car.carId,
    ecv: car.ecv ?? "",
    vin: car.vin ?? "",
    make: car.manufacturerId != null ? maps.manufacturers.get(car.manufacturerId) ?? null : null,
    model: car.model ?? "",
    color: car.colorId != null ? maps.colors.get(car.colorId) ?? null : null,
    ownerType: car.ownerTypeId != null ? maps.ownerTypes.get(car.ownerTypeId) ?? null : null,
    kindHint: "replacement_car",
    swhouseBranchId: car.lasFilialId ?? null,
    swhouseBranchName: car.lasFilialId != null ? maps.branches.get(car.lasFilialId) ?? null : null,
    branchInternalId: mapSwhouseBranch(branchMap, car.lasFilialId ?? null),
    rentTo: car.rentTo ?? null,
    details: vehicleDetails(car),
  };
}

export function vehicleDetails(car: SwhouseCarRaw): Record<string, string | number | boolean | null> {
  const raw = car as unknown as Record<string, unknown>;
  const fields = ["carId", "ecv", "vin", "model", "manufacturerId", "colorId", "typeId", "ownerTypeId", "cotp",
    "lasFilialId", "lastUserId", "rentId", "assistanceRentId", "rentTo", "price1", "price2", "price3", "price4",
    "insuranceValidUntil", "lastCarService", "insuranceDeductiblePercentage", "insuranceDeductibleAmount"];
  return Object.fromEntries(fields.flatMap((key) => {
    const value = raw[key];
    return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number"
      ? [[key, value]] : [];
  }));
}

/**
 * Celá SWHouse flotila (ownerTypeId vo fleetOwnerTypeIds, napr. 3/4) → normalizované vozidlá.
 * Zdroj pravdy pre roster je getCarsOccupancyAll: obsahuje voľné aj obsadené autá
 * a na rozdiel od generického getCars aj lasFilialId. Čistá funkcia.
 */
export function normalizeFleet(
  cars: SwhouseCarRaw[],
  maps: SwhouseCodelistMaps,
  branchMap: Record<string, string>,
  fleetOwnerTypeIds: number[],
): SwhouseReplacementVehicle[] {
  const owners = new Set(fleetOwnerTypeIds);
  const vehicles: SwhouseReplacementVehicle[] = [];
  for (const car of cars) {
    if (!car || typeof car.carId !== "number" || car.carId <= 0 || !owners.has(car.ownerTypeId ?? -1)) {
      continue;
    }
    const vehicle = normalizeFleetCar(car, maps, branchMap);
    if (vehicle) {
      vehicles.push(vehicle);
    }
  }
  return vehicles;
}

/**
 * Párovanie obsadenosti: getCarsOccupancy vracia LEN voľné autá, takže obsadené
 * = autá flotily (ownerTypeId vo fleetOwnerTypeIds) mimo voľného zoznamu.
 * Pri duplicitnej ŠPZ (starý + nový záznam v SWHouse) vyhráva "voľné". Čistá funkcia.
 */
export function pairFleetOccupancy(
  freeRaw: SwhouseCarOccupancyRaw[],
  allCars: SwhouseCarRaw[],
  fleetOwnerTypeIds: number[],
): SwhouseFleetOccupancy {
  const ownerTypes = new Set(fleetOwnerTypeIds);
  const freePlates = new Set<string>();
  for (const car of freeRaw) {
    if (!car || typeof car.carId !== "number" || car.carId <= 0 || !ownerTypes.has(car.ownerTypeId ?? -1)) {
      continue;
    }
    const plate = normalizePlateForPairing(car.ecv);
    if (plate) {
      freePlates.add(plate);
    }
  }
  const occupiedPlates = new Set<string>();
  for (const car of allCars) {
    if (!car || typeof car.carId !== "number" || car.carId <= 0 || !ownerTypes.has(car.ownerTypeId ?? -1)) {
      continue;
    }
    const plate = normalizePlateForPairing(car.ecv);
    if (plate && !freePlates.has(plate)) {
      occupiedPlates.add(plate);
    }
  }
  return { freePlates: [...freePlates].sort(), occupiedPlates: [...occupiedPlates].sort() };
}

/** Agregácia počtov voľných vozidiel na naše pobočky (+ nepriradené). Čistá funkcia. */
export function aggregateAvailability(vehicles: SwhouseReplacementVehicle[]): SwhouseAvailability {
  const availabilityByBranch: Record<string, number> = {};
  let unassignedCount = 0;
  for (const vehicle of vehicles) {
    if (vehicle.branchInternalId) {
      availabilityByBranch[vehicle.branchInternalId] = (availabilityByBranch[vehicle.branchInternalId] ?? 0) + 1;
    } else {
      unassignedCount += 1;
    }
  }
  return { availabilityByBranch, unassignedCount, totalFree: vehicles.length };
}

export type SwhouseReplacementSnapshot = SwhouseAvailability & {
  /** null = párovanie nedostupné (getCars zlyhal) — UI ponechá lokálne stavy. */
  fleetOccupancy: SwhouseFleetOccupancy | null;
};

/**
 * Vysoká úroveň: vráti agregát voľných náhradných vozidiel per pobočka
 * + párovacie ECV sety (voľné/obsadené) pre Flotilu.
 * Pri nekonfigurácii alebo zlyhaní vendora vráti null (signál fallbacku na manuálnu hodnotu).
 * NIKDY nehádže.
 */
export async function getReplacementVehicleSnapshot(options?: {
  client?: SwhouseClient;
  config?: SwhouseConfig;
}): Promise<SwhouseReplacementSnapshot | null> {
  let config: SwhouseConfig;
  try {
    config = options?.config ?? swhouseConfigFromEnv();
  } catch {
    return null; // nenakonfigurované → fallback
  }

  const client = options?.client ?? new SwhouseClient(config);

  try {
    const [occupancy, allOccupancy] = await Promise.all([
      client.getCarsOccupancy(),
      client.getCarsOccupancyAll().catch(() => null),
    ]);
    if (!occupancy.ok || !Array.isArray(occupancy.data)) {
      return null;
    }
    let maps = EMPTY_MAPS;
    try {
      maps = await getCodelistMaps(client, config.codelistTtlMs);
    } catch {
      // číselníky sú best-effort; počty fungujú aj bez nich
    }
    const allowedOwnerTypes = new Set(config.fleetOwnerTypeIds);
    const freeFleet = occupancy.data.filter((car) => allowedOwnerTypes.has(car.ownerTypeId ?? -1));
    const vehicles = normalizeOccupancy(freeFleet, maps, config.branchMap);
    const fleetOccupancy =
      allOccupancy?.ok && Array.isArray(allOccupancy.data)
        ? pairFleetOccupancy(freeFleet, allOccupancy.data, config.fleetOwnerTypeIds)
        : null;
    return { ...aggregateAvailability(vehicles), fleetOccupancy };
  } catch {
    return null;
  }
}
