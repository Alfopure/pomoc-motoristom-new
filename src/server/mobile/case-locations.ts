import "server-only";
import type { CaseDetailSnapshot } from "@/data/case-detail-repository";
import type { MobileCaseCreateInput, MobileCaseMap, MobileCaseMapLocation, MobileCasePlaceSelection } from "@/lib/mobile-api";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";

export function locationText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || !!value.trim())
    && !/[\u0000-\u001f\u007f]/.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

export function locationPoint(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  return typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90
    && typeof lng === "number" && Number.isFinite(lng) && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

export function parseMobilePlaceSelection(value: unknown): MobileCasePlaceSelection | null {
  const invalid = (): never => { throw new MutationError("Neplatný výber miesta.", 400); };
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["label", "address", "lat", "lng", "provider", "placeId"].includes(key))
    || !locationText(item.label, 200) || !locationText(item.address, 500)
    || !locationPoint(item.lat, item.lng)
    || item.provider !== "google_places" && item.provider !== "manual" && item.provider !== "approximate"
    || Object.hasOwn(item, "placeId") && !locationText(item.placeId, 300)) return invalid();
  return { label: item.label.trim(), address: item.address.trim(), lat: item.lat as number, lng: item.lng as number,
    provider: item.provider, ...(typeof item.placeId === "string" ? { placeId: item.placeId.trim() } : {}) };
}

/** Preserve old commands exactly; only new explicit selections clear obsolete fallback text. */
export function mobileLocationChanges<T extends MobileCaseCreateInput>(input: T): T {
  return { ...input,
    ...(input.pickup !== undefined ? { manualPickupAddress: "" } : input.manualPickupAddress !== undefined ? { pickup: null } : {}),
    ...(input.destination !== undefined ? { manualDestinationAddress: "" } : input.manualDestinationAddress !== undefined ? { destination: null } : {}),
  };
}

export function mobileCaseMap(snapshot: CaseDetailSnapshot): MobileCaseMap {
  const project = (row: CaseDetailSnapshot["locations"]["pickup"], client = false): MobileCaseMapLocation | null => {
    // A corrupt optional map row must not make the existing case card unreadable.
    // Display bounds are wider than new selection input, without truncating stored text.
    if (!row || !isUuid(row.id) || !locationText(row.label, 10_000, true) || !locationText(row.address, 10_000, true)) return null;
    const source = row.provider === "browser_geolocation" ? "client_gps"
      : row.provider === "google_places" || row.provider === "manual" || row.provider === "approximate" ? row.provider : "unknown";
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
    const accuracy = metadata.accuracy_meters;
    return { id: row.id, label: row.label, address: row.address, point: locationPoint(row.lat, row.lng), source,
      accuracyMeters: source === "client_gps" && typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
      capturedAt: client && isHistoryTimestamp(snapshot.clientCapturedAt) ? snapshot.clientCapturedAt : null };
  };
  return { pickup: project(snapshot.locations.pickup), destination: project(snapshot.locations.destination),
    clientLocation: project(snapshot.locations.clientLocation, true) };
}
