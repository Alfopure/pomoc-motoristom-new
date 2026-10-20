import type { MobileActiveCall } from "../../../src/lib/mobile-api";
import { callStatus, formatNumber } from "../lib/display";

/** Height of the bar and its gap above the tab bar; content ends above it. */
export const CALL_BAR_SPACE = 52;

export type CallBarCall = { id: string; title: string; status: string; startedAt: string; count: number };

const calls = (count: number) => count + (count <= 4 ? " hovory" : " hovorov");

/** Calls the server lists on the dispatcher's account, for example on a desk
 * phone. The call in this phone is excluded: the call panel already shows it,
 * and a call it just ended stays listed until the next console read. */
export function callBarCall(active: readonly MobileActiveCall[], exclude: readonly string[]): CallBarCall | null {
  const skipped = new Set(exclude.map(id => id.toLowerCase()));
  const shown = active.filter(call => !skipped.has(call.id.toLowerCase()));
  const first = shown[0];
  if (!first) return null;
  return shown.length > 1 ? { id: first.id, title: calls(shown.length) + " na vašom účte", status: "Ústredňa", startedAt: first.startedAt, count: shown.length }
    : { id: first.id, title: first.contactName || first.name || formatNumber(first.number), status: callStatus(first.state), startedAt: first.startedAt, count: 1 };
}

/** "0:07", "12:31", "1:02:09"; empty when the start is unknown. */
export function elapsed(fromIso: string, now: number): string {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return "";
  const total = Math.floor(Math.max(0, now - from) / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? hours + ":" + pad(minutes) + ":" + pad(seconds) : minutes + ":" + pad(seconds);
}
