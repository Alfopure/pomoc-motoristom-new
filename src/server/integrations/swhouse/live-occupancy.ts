import type { SwhouseCarOccupancyRaw } from "./types";
import { normalizePlateForPairing } from "./replacement-vehicles";

/** Never infer occupied from a stale local roster or match a recycled plate to another carId. */
export function computeLiveOccupancy(all: SwhouseCarOccupancyRaw[], free: SwhouseCarOccupancyRaw[], ownerTypes: number[]) {
  const fleet = all.filter((car) => car?.carId > 0 && ownerTypes.includes(car.ownerTypeId));
  if (!fleet.length) throw new Error("SWHouse nevrátil žiadnu flotilu; posledný stav zostáva zachovaný.");
  const byId = new Map(fleet.map((car) => [car.carId, car]));
  const plates = fleet.map((car) => normalizePlateForPairing(car.ecv));
  if (byId.size !== fleet.length || plates.some((plate) => !plate) || new Set(plates).size !== plates.length) {
    throw new Error("SWHouse obsahuje nejednoznačné carId alebo ŠPZ; obsadenosť sa neprepísala.");
  }
  const freeIds = new Set<number>();
  for (const car of free.filter((car) => car?.carId > 0 && ownerTypes.includes(car.ownerTypeId))) {
    const rosterCar = byId.get(car.carId);
    if (!rosterCar || normalizePlateForPairing(rosterCar.ecv) !== normalizePlateForPairing(car.ecv)) {
      throw new Error("SWHouse voľné vozidlá nesúhlasia s aktuálnym rosterom; opakujte obnovu.");
    }
    freeIds.add(car.carId);
  }
  return {
    fleet,
    states: new Map(fleet.map((car) => [String(car.carId), freeIds.has(car.carId) ? "free" as const : "occupied" as const])),
    freePlates: fleet.filter((car) => freeIds.has(car.carId)).map((car) => normalizePlateForPairing(car.ecv)).sort(),
    occupiedPlates: fleet.filter((car) => !freeIds.has(car.carId)).map((car) => normalizePlateForPairing(car.ecv)).sort(),
  };
}
