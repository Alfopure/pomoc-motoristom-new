import type { MobileToolFleetAsset } from "../../../src/lib/mobile-tools";
const MAX_AGE = 10 * 60_000;
function fresh(value: string | null, now: number) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 60_000 && now - time <= MAX_AGE;
}
export function fleetFreshness(asset: MobileToolFleetAsset, now: number): { gpsFresh: boolean; availability: "free" | "occupied" | "unverified" | "stale" } {
  const gpsFresh = Boolean(asset.point && asset.gps && !asset.gps.stale && fresh(asset.gps.positionTime, now) && fresh(asset.gps.syncedAt, now));
  const availability = asset.occupancy === "stale" ? "stale" : asset.availabilityVerified === false || !asset.occupancy || asset.occupancy === "unverified" ? "unverified"
    : !fresh(asset.occupancyCheckedAt, now) ? "stale" : asset.occupancy;
  return { gpsFresh, availability };
}
