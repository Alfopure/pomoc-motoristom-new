import type { MobileCasePlaceSelection } from "../../../src/lib/mobile-api";
import { MAX_ROUTE_INTERMEDIATES } from "../../../src/lib/driving-route";
import { placeSelection } from "../cases/location";

export type RouteStop = { id: number; address: string; selection: MobileCasePlaceSelection | null };
export function editStop(stop: RouteStop, address: string): RouteStop { return { ...stop, address, selection: null }; }
export function chooseStop(stop: RouteStop, value: MobileCasePlaceSelection): RouteStop {
  const selection = placeSelection(value);
  return { ...stop, address: selection.address, selection: { ...selection } };
}
export function confirmCoordinates(stop: RouteStop, latitude: string, longitude: string): RouteStop {
  if (!latitude.trim() || !longitude.trim()) throw new Error("Zadajte zemepisnú šírku aj dĺžku.");
  const lat = Number(latitude.replace(",", ".")), lng = Number(longitude.replace(",", "."));
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) throw new Error("Súradnice musia byť platné čísla v rozsahu −90 až 90 a −180 až 180.");
  const address = stop.address.trim() || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  return chooseStop(stop, { label: address.slice(0, 200), address, lat, lng, provider: "manual" });
}
export function routeInput(stops: RouteStop[]) {
  if (stops.length < 2 || stops.length > MAX_ROUTE_INTERMEDIATES + 2) throw new Error("Trasa potrebuje štart, cieľ a najviac 25 bodov prejazdu.");
  const points = stops.map(stop => {
    if (!stop.selection) throw new Error("Potvrďte miesto každého bodu na mape alebo jeho súradnice.");
    const value = placeSelection(stop.selection);
    return { lat: value.lat, lng: value.lng };
  });
  return { origin: points[0], destination: points[points.length - 1], intermediates: points.slice(1, -1) };
}
/** Google Maps URLs supports only three waypoints on mobile browsers. Never omit stops. */
export function routeNavigationUrl(stops: RouteStop[]): string {
  const input = routeInput(stops);
  if (input.intermediates.length > 3) throw new Error("Navigáciu možno otvoriť pre trasu najviac s tromi bodmi prejazdu. Celú trasu si pozrite na mape.");
  const point = (value: {lat:number;lng:number}) => `${value.lat},${value.lng}`;
  const params = new URLSearchParams({ api: "1", origin: point(input.origin), destination: point(input.destination), travelmode: "driving", dir_action: "navigate" });
  if (input.intermediates.length) params.set("waypoints", input.intermediates.map(point).join("|"));
  const url = `https://www.google.com/maps/dir/?${params}`;
  if (url.length > 2048) throw new Error("Trasa je príliš dlhá pre externú navigáciu.");
  return url;
}
