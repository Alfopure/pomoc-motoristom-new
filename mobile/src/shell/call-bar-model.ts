import type { MobileActiveCall } from "../../../src/lib/mobile-api";
import { callStatus, formatNumber } from "../lib/display";
import type { PhoneState } from "../voice/phone";

/** Height of the bar and its gap above the tab bar; content ends above it. */
export const CALL_BAR_SPACE = 52;

export type CallBarCall =
  | { kind: "phone"; title: string; status: string }
  | { kind: "server"; id: string; title: string; status: string; startedAt: string; count: number };

/** What the bar shows: the call in this phone first, then calls the server
 * knows on the dispatcher's account (for example on a desk phone). */
export function callBarCall(phone: PhoneState["call"], active: readonly MobileActiveCall[]): CallBarCall | null {
  if (phone) {
    const status = phone.state === "HELD" ? "Podržaný" : ["DROPPED", "RECONNECTING"].includes(phone.state) ? "Obnovuje sa"
      : phone.connected ? "Prebieha" : phone.outgoing ? "Vytáča sa" : "Zvoní";
    return { kind: "phone", title: phone.displayName || formatNumber(phone.number), status };
  }
  const first = active[0];
  if (!first) return null;
  return { kind: "server", id: first.id, title: active.length > 1 ? active.length + " hovory na vašom účte" : first.name || formatNumber(first.number),
    status: active.length > 1 ? "Otvoriť Ústredňu" : callStatus(first.state), startedAt: first.startedAt, count: active.length };
}

/** "0:07", "12:31", "1:02:09"; empty when the start is unknown. */
export function elapsed(fromIso: string, now: number): string {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return "";
  const total = Math.floor(Math.max(0, now - from) / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? hours + ":" + pad(minutes) + ":" + pad(seconds) : minutes + ":" + pad(seconds);
}
