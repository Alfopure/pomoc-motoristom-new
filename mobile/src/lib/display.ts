import type { MobilePresence } from "../../../src/lib/mobile-api";

export const presenceLabels: Record<MobilePresence, string> = {
  available: "Dostupný", ringing: "Zvoní hovor", on_call: "Na hovore",
  after_call_work: "Dokončovanie hovoru", paused: "Pauza", offline: "Nedostupný",
};
const statuses: Record<string, string> = {
  incoming: "Prichádzajúci", ringing_agent: "Zvoní", answered: "Prijatý", missed: "Zmeškaný",
  abandoned_queue: "Ukončený v čakaní", outbound: "Odchádzajúci", ended: "Ukončený", failed: "Neúspešný",
  ringing: "Zvoní", talking: "Prebieha", conference: "Prebieha", held: "Podržaný", parked: "Čaká", queued: "Čaká",
};
export function callStatus(value: string) { return statuses[value] ?? "Stav nie je známy"; }
export function formatTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("sk-SK", { timeZone: "Europe/Bratislava", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "Čas nie je dostupný";
}
export function formatNumber(value: string | null) {
  if (!value) return "Neznáme číslo";
  const digits = value.replace(/\D/g, "");
  const international = digits.startsWith("00") ? digits.slice(2) : digits;
  if (international.startsWith("421") && international.length === 12) return "+421 " + international.slice(3, 6) + " " + international.slice(6, 9) + " " + international.slice(9);
  return value;
}
export function dialable(value: string | null) { return Boolean(value && /^\+?[\d ()/.-]{2,40}$/.test(value) && value.replace(/\D/g, "").length >= 2); }
