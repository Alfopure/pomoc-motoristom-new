import type { MobileCaseDetailData, MobileCaseMap, MobileCaseMapLocation, MobileCasePlaceSelection } from "../../../src/lib/mobile-api";
import { draftDate, draftId, draftKeys, draftObject } from "../drafts/port";

export function locationText(value: unknown, max: number, empty = false): value is string {
  if (typeof value !== "string") return false;
  try { encodeURIComponent(value); } catch { return false; }
  return value.length <= max && (empty || value.trim().length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value);
}
export function locationPoint(value: unknown): { lat: number; lng: number } {
  const v = draftObject(value); draftKeys(v, ["lat", "lng"]);
  if (typeof v.lat !== "number" || !Number.isFinite(v.lat) || Math.abs(v.lat) > 90
    || typeof v.lng !== "number" || !Number.isFinite(v.lng) || Math.abs(v.lng) > 180) throw new Error("Neplatná poloha.");
  return { lat: v.lat, lng: v.lng };
}
export function placeSelection(value: unknown): MobileCasePlaceSelection {
  const v = draftObject(value); draftKeys(v, ["label", "address", "lat", "lng", "provider"], ["placeId"]);
  if (!locationText(v.label, 200) || !locationText(v.address, 500) || !(v.placeId === undefined || locationText(v.placeId, 300))
    || !["google_places", "manual", "approximate"].includes(v.provider as string)) throw new Error("Neplatné miesto.");
  return { label: v.label.trim(), address: v.address.trim(), ...locationPoint({ lat: v.lat, lng: v.lng }),
    provider: v.provider as MobileCasePlaceSelection["provider"], ...(v.placeId === undefined ? {} : { placeId: v.placeId.trim() }) };
}
function mapLocation(value: unknown): MobileCaseMapLocation | null {
  if (value === null) return null;
  const v = draftObject(value); draftKeys(v, ["id", "label", "address", "point", "source", "accuracyMeters", "capturedAt"]);
  if (!draftId(v.id) || !locationText(v.label, 10000, true) || !locationText(v.address, 10000, true)
    || !["google_places", "manual", "approximate", "client_gps", "unknown"].includes(v.source as string)
    || !(v.accuracyMeters === null || typeof v.accuracyMeters === "number" && Number.isFinite(v.accuracyMeters) && v.accuracyMeters >= 0)
    || !(v.capturedAt === null || draftDate(v.capturedAt))) throw new Error("Neplatná mapa prípadu.");
  return { id: v.id, label: v.label, address: v.address, point: v.point === null ? null : locationPoint(v.point), source: v.source as MobileCaseMapLocation["source"], accuracyMeters: v.accuracyMeters, capturedAt: v.capturedAt };
}
export function caseMap(value: unknown): MobileCaseMap {
  const v = draftObject(value); draftKeys(v, ["pickup", "destination", "clientLocation"]);
  return { pickup: mapLocation(v.pickup), destination: mapLocation(v.destination), clientLocation: mapLocation(v.clientLocation) };
}
/** Clone before recursively freezing so caller-owned candidates cannot change a WAL command. */
export function freezeCommand<T>(value: T): T {
  const clone: T = JSON.parse(JSON.stringify(value));
  const freeze = (item: unknown) => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(clone); return clone;
}
export function compareRevisions(value: string, minimum: string) {
  const difference = Date.parse(value) - Date.parse(minimum);
  const fraction = (v: string) => Number((v.match(/[T ]\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1].slice(3) ?? "").padEnd(6, "0").slice(0, 6));
  return difference || fraction(value) - fraction(minimum);
}

const locationSourceLabels = { google_places: "Google Maps", manual: "Ručne zvolená poloha", approximate: "Približná poloha", client_gps: "Poloha od klienta", unknown: "Neznámy zdroj" };
export function describeSelectedPlace(selection: MobileCasePlaceSelection | null | undefined): string {
  return selection ? `${selection.address} · ${selection.lat}, ${selection.lng} · ${locationSourceLabels[selection.provider]}` : "Odstrániť uložené miesto";
}
export function describeCurrentPlace(detail: MobileCaseDetailData, target: "pickup" | "destination"): string {
  const location = detail.map?.[target];
  const address = location?.address || (target === "pickup" ? detail.pickupAddress : detail.destinationAddress)
    || detail.editable[target === "pickup" ? "manualPickupAddress" : "manualDestinationAddress"];
  if (!address && !location?.point) return "Miesto nie je uvedené";
  return `${address || "Bez adresy"} · ${location?.point ? `${location.point.lat}, ${location.point.lng} · ${locationSourceLabels[location.source]}` : "Poloha nie je uvedená"}`;
}
