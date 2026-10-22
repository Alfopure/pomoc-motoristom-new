import type { MobileDelivery, MobileDeliveryAction } from "../../../src/lib/mobile-api";
import type { TagTone } from "../design/detail";

/** What a pristavovač sees and does with one delivery, without any screen. */
export const deliveryStatusLabels: Record<MobileDelivery["status"], string> = {
  offered: "Čaká na prijatie", accepted: "Prijaté", en_route: "Na ceste", arrived: "Na mieste", completed: "Dokončené",
  rejected: "Odmietnuté", cancelled: "Zrušené", expired: "Platnosť skončila",
};
export const deliveryStatusTones: Record<MobileDelivery["status"], TagTone> = {
  offered: "orange", accepted: "blue", en_route: "blue", arrived: "green", completed: "gray", rejected: "red", cancelled: "gray", expired: "gray",
};
const OPEN = ["offered", "accepted", "en_route", "arrived"];

export function isOpen(delivery: Pick<MobileDelivery, "status" | "expiresAt">, now = Date.now()): boolean {
  return OPEN.includes(delivery.status) && Date.parse(delivery.expiresAt) > now;
}
/** The pristavovač's position goes to the dispatcher only between accepting and finishing. */
export function sharesPosition(delivery: Pick<MobileDelivery, "status" | "expiresAt">, now = Date.now()): boolean {
  return isOpen(delivery, now) && delivery.status !== "offered";
}

export type DeliveryStep = { action: MobileDeliveryAction; label: string; confirm: string | null };
/** One main step at a time, as on the link page: accept, set off, arrive, hand over. */
export function nextStep(delivery: Pick<MobileDelivery, "status" | "expiresAt">, now = Date.now()): DeliveryStep | null {
  if (!isOpen(delivery, now)) return null;
  switch (delivery.status) {
    case "offered": return { action: "accept", label: "Prijať pristavenie", confirm: null };
    case "accepted": return { action: "en_route", label: "Vyrážam", confirm: null };
    case "en_route": return { action: "arrived", label: "Som na mieste", confirm: null };
    case "arrived": return { action: "complete", label: "Auto odovzdané", confirm: "Potvrdiť, že je auto odovzdané? Pristavenie sa tým uzavrie." };
    default: return null;
  }
}

/** The car to take, written as people say it: "VW Golf · ZA999AB". */
export function replacementCar(delivery: Pick<MobileDelivery, "card">): string | null {
  const car = delivery.card?.replacement?.vehicle;
  if (!car) return null;
  return [[car.make, car.model].filter(Boolean).join(" "), car.plate].filter(Boolean).join(" · ") || null;
}
export function deliveryTitle(delivery: Pick<MobileDelivery, "card" | "caseNumber">): string {
  return replacementCar(delivery) ?? delivery.card?.action ?? "Pristavenie";
}
export function deliveryPlace(delivery: Pick<MobileDelivery, "card">): string | null {
  const place = delivery.card?.replacement?.deliveryPlace?.trim();
  return place || delivery.card?.pickup?.address?.trim() || null;
}

export type DeliveryPoint = { key: "car" | "client" | "destination"; label: string; title: string; lat: number; lng: number };
/** Map pins: the replacement car by GPS, the client's place and the tow destination when they have coordinates. */
export function deliveryPoints(delivery: Pick<MobileDelivery, "card" | "replacementPosition">): DeliveryPoint[] {
  const points: DeliveryPoint[] = [];
  if (delivery.replacementPosition) points.push({ key: "car", label: "Náhradné auto", title: replacementCar(delivery) ?? "Náhradné auto", lat: delivery.replacementPosition.lat, lng: delivery.replacementPosition.lng });
  const pickup = delivery.card?.pickup;
  if (pickup?.lat != null && pickup.lng != null) points.push({ key: "client", label: "Klient", title: pickup.address || "Miesto klienta", lat: pickup.lat, lng: pickup.lng });
  const destination = delivery.card?.destination;
  if (destination?.lat != null && destination.lng != null) points.push({ key: "destination", label: "Cieľ odťahu", title: destination.address || "Cieľ", lat: destination.lat, lng: destination.lng });
  return points;
}

/** A point on the map rather than a route, e.g. where the pristavovač was last. */
export function positionUrl(position: { lat: number; lng: number }): string {
  return "https://www.google.com/maps/search/?api=1&query=" + position.lat.toFixed(6) + "%2C" + position.lng.toFixed(6);
}

/** "pred chvíľou", "pred 5 min", "pred 2 h", "21. 10. 14:30". */
export function agoLabel(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "pred chvíľou";
  if (minutes < 60) return "pred " + minutes + " min";
  if (minutes < 24 * 60) return "pred " + Math.floor(minutes / 60) + " h";
  return new Intl.DateTimeFormat("sk-SK", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Bratislava" }).format(new Date(iso));
}
export function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat("sk-SK", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Bratislava" }).format(new Date(iso));
}
/** Open deliveries first (newest on top), then finished ones. */
export function sortDeliveries(list: readonly MobileDelivery[], now = Date.now()): MobileDelivery[] {
  return [...list].sort((a, b) => Number(isOpen(b, now)) - Number(isOpen(a, now)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
