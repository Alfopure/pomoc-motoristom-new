import { parseMobileMapPreview } from "./mobile-map-preview";
import type { MobileScope } from "./mobile-api";
import type { VehicleLookupInput, VehicleQuery, VehicleSourceResult } from "./vehicle-lookup";

export const MOBILE_TOOL_FLEET_PAGE_SIZE = 25;
export const MOBILE_TOOL_FLEET_MAX_ASSETS = 200;
export const MOBILE_TOOL_ROUTE_MAX_INTERMEDIATES = 25;
export const MOBILE_TOOL_MAX_POLYLINE = 200_000;
export const MOBILE_TOOL_FLEET_KINDS = ["tow_truck", "replacement_car"] as const;
export const MOBILE_TOOL_FLEET_STATUSES = ["available", "reserved", "rented", "assigned", "busy", "service", "offline"] as const;
export type MobileToolsScope = MobileScope & { organizationId: string };
export type MobileToolPoint = { lat: number; lng: number };
export type MobileToolLookupInput = VehicleLookupInput;
export type MobileToolLookupSource = Pick<VehicleSourceResult, "source" | "status" | "fetchedAt" | "facts" | "warnings"> & { candidates: NonNullable<VehicleSourceResult["candidates"]> };
export type MobileToolLookup = MobileToolsScope & {
  query: VehicleQuery;
  result: { id: string; fetchedAt: string; sources: MobileToolLookupSource[] };
  cached: boolean;
  conflict: string | null;
};
export type MobileToolRouteInput = { origin: MobileToolPoint; destination: MobileToolPoint; intermediates?: MobileToolPoint[] };
export type MobileToolRouteLeg = { distanceMeters: number; durationSeconds: number; encodedPolyline: string };
export type MobileToolRoute = MobileToolsScope & {
  request: Required<MobileToolRouteInput>;
  route: MobileToolRouteLeg & { legs: MobileToolRouteLeg[]; provider: "google-routes"; calculatedAt: string };
};
export type MobileToolFleetFilter = {
  q: string;
  kind: "all" | typeof MOBILE_TOOL_FLEET_KINDS[number];
  status: "all" | typeof MOBILE_TOOL_FLEET_STATUSES[number];
  offset: number;
};
export type MobileToolFleetAsset = {
  id: string;
  kind: typeof MOBILE_TOOL_FLEET_KINDS[number];
  label: string;
  licensePlate: string;
  make: string | null;
  model: string | null;
  status: typeof MOBILE_TOOL_FLEET_STATUSES[number];
  internalStatus: typeof MOBILE_TOOL_FLEET_STATUSES[number];
  occupancy: "occupied" | "free" | "unverified" | "stale" | null;
  occupancyCheckedAt: string | null;
  availabilityVerified: boolean | null;
  point: MobileToolPoint | null;
  gps: { source: string; positionTime: string | null; syncedAt: string | null; stale: boolean } | null;
};
export type MobileToolFleet = MobileToolsScope & {
  selection: MobileToolFleetFilter;
  assets: MobileToolFleetAsset[];
  total: number;
  nextOffset: number | null;
  snapshot: "stored";
  gpsLastSuccessAt: string | null;
};

/** Share the exact map renderer boundary instead of a second polyline decoder. */
export function isMobileToolPolyline(value: unknown): value is string {
  try {
    parseMobileMapPreview({ points: [{ lat: 0, lng: 0, label: "Trasa" }], encodedPolyline: value });
    return true;
  } catch { return false; }
}
