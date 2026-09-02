import "server-only";

import type { SwhouseClient } from "./client";
import type { SwhouseCodelistItem } from "./types";

export type SwhouseCodelistMaps = {
  manufacturers: Map<number, string>;
  colors: Map<number, string>;
  carTypes: Map<number, string>;
  ownerTypes: Map<number, string>;
  branches: Map<number, string>;
  expiresAt: number;
};

let cache: SwhouseCodelistMaps | null = null;
let inFlight: Promise<SwhouseCodelistMaps> | null = null;

/** Len pre testy. */
export function __resetSwhouseCodelists(): void {
  cache = null;
  inFlight = null;
}

function toMap(items: SwhouseCodelistItem[] | null, idKey: keyof SwhouseCodelistItem): Map<number, string> {
  const map = new Map<number, string>();
  if (!Array.isArray(items)) {
    return map;
  }
  for (const item of items) {
    const id = item?.[idKey];
    const name = item?.name;
    if (typeof id === "number" && typeof name === "string") {
      map.set(id, name);
    }
  }
  return map;
}

async function load(client: SwhouseClient, ttlMs: number): Promise<SwhouseCodelistMaps> {
  // Best-effort: zlyhanie jedného číselníka → prázdna mapa (resolve vráti null), nie chyba.
  const [man, col, typ, own, bra] = await Promise.all([
    client.getManufacturers(),
    client.getCarColors(),
    client.getCarTypes(),
    client.getOwnerTypes(),
    client.getBranches(),
  ]);
  return {
    manufacturers: toMap(man.data, "manufacturerId"),
    colors: toMap(col.data, "colorId"),
    carTypes: toMap(typ.data, "typeId"),
    ownerTypes: toMap(own.data, "ownerTypeId"),
    branches: toMap(bra.data, "branchId"),
    expiresAt: Date.now() + ttlMs,
  };
}

/** Vráti cachované mapy číselníkov (TTL); pri prvom volaní lazy-load (single-flight). Nikdy nehádže. */
export async function getCodelistMaps(client: SwhouseClient, ttlMs: number): Promise<SwhouseCodelistMaps> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache;
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = load(client, ttlMs)
    .then((maps) => {
      cache = maps;
      return maps;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
