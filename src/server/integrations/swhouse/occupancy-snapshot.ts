import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { FleetAssetOccupancy } from "@/domain/types";

import { normalizePlateForPairing } from "./replacement-vehicles";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** Prah veku snapshotu, po ktorom je occupancy „stale" (zladené s GPS_STALE_AFTER_MINUTES). */
export const OCCUPANCY_STALE_AFTER_MINUTES = 10;

/** Najnovší occupancy snapshot pripravený na párovanie (ŠPZ už normalizované). */
export type OccupancySnapshot = {
  capturedAt: string;
  occupiedPlates: ReadonlySet<string>;
  freePlates: ReadonlySet<string>;
};

/** True keď snapshot chýba alebo je starší než prah → nevieme spoľahlivo povedať obsadenosť. */
export function isOccupancySnapshotStale(
  snapshot: OccupancySnapshot | null,
  now: number = Date.now(),
  staleAfterMinutes: number = OCCUPANCY_STALE_AFTER_MINUTES,
): boolean {
  if (!snapshot) {
    return true;
  }
  const captured = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(captured)) {
    return true;
  }
  return now - captured > staleAfterMinutes * 60_000;
}

/**
 * Odvodí per-asset occupancy stav z posledného snapshotu.
 * stale (chýba/starý) > occupied (ŠPZ vo voľnom liste chýba, je vo flotile) > free > unverified (SWHouse ju nepozná).
 * Čistá funkcia — používa ju loader (mapFleetAsset) aj assignCase guard (jeden zdroj logiky).
 */
export function deriveReplacementOccupancy(
  snapshot: OccupancySnapshot | null,
  licensePlate: string | null | undefined,
  now: number = Date.now(),
): FleetAssetOccupancy {
  if (isOccupancySnapshotStale(snapshot, now)) {
    return "stale";
  }
  const plate = normalizePlateForPairing(licensePlate);
  if (!plate) {
    return "unverified";
  }
  if (snapshot!.occupiedPlates.has(plate)) {
    return "occupied";
  }
  if (snapshot!.freePlates.has(plate)) {
    return "free";
  }
  return "unverified";
}

/** Guard rozhodnutie pre assignCase pri overene obsadenom aute. */
export function isOccupiedAssignmentBlocked(occupancy: FleetAssetOccupancy | undefined, allowOverride: boolean): boolean {
  return occupancy === "occupied" && !allowOverride;
}

/**
 * Pri chýbajúcom alebo neaktuálnom zdroji pravdy vyžaduj vedomé potvrdenie.
 * Prevádzku to nezablokuje natrvalo, no neistota nemôže prejsť ako bežné voľné auto.
 */
export function isUnverifiedAssignmentBlocked(occupancy: FleetAssetOccupancy | undefined, allowOverride: boolean): boolean {
  return (occupancy === "unverified" || occupancy === "stale" || occupancy === undefined) && !allowOverride;
}

/** Načíta NAJNOVŠÍ occupancy snapshot pre organizáciu. Tolerantné k chýbajúcej tabuľke (pred migráciou) → null. */
export async function loadLatestOccupancySnapshot(
  supabase: AdminClient,
  organizationId: string,
): Promise<OccupancySnapshot | null> {
  const result = await supabase
    .from("motorist_fleet_replacement_occupancy")
    .select("captured_at, occupied_plates, free_plates")
    .eq("organization_id", organizationId)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error || !result.data) {
    return null;
  }

  return {
    capturedAt: result.data.captured_at,
    occupiedPlates: normalizePlateSet(result.data.occupied_plates),
    freePlates: normalizePlateSet(result.data.free_plates),
  };
}

function normalizePlateSet(plates: string[] | null | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  for (const plate of plates ?? []) {
    const normalized = normalizePlateForPairing(plate);
    if (normalized) {
      set.add(normalized);
    }
  }
  return set;
}
