import type { MobileDelivery, MobileFieldMe } from "../../../src/lib/mobile-api";
import { canUseDeliveryCache, sharesPosition } from "./model";
import { MobileApiError } from "../lib/api";

/** A refusal on a command/tracker/detail applies to the whole field account,
 * before the next list poll. Only a verified identity/list can restore access. */
export class DeliveryAccess {
  private error: MobileApiError | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  snapshot = () => this.error;
  ticket = () => this.version;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  failed = (error: MobileApiError) => {
    if (![401, 403].includes(error.status) && !(error.status === 503 && error.code === "delivery_unavailable")) return;
    if (this.error === error) return;
    this.version++; this.error = error; this.listeners.forEach(notify => notify());
  };
  verified = (ticket = this.version) => {
    if (!this.error || ticket !== this.version) return;
    this.error = null; this.listeners.forEach(notify => notify());
  };
}

/** A stale identity is useful through a connection failure. A refusal or an
 * untrusted identity/list must end access and stop using old tracking state. */
export function deliveryMember(me: MobileFieldMe | undefined, error: unknown, listError?: unknown): string | null {
  return canUseDeliveryCache(error) && canUseDeliveryCache(listError) ? me?.memberId ?? null : null;
}
export function deliverySharing(memberId: string | null, list: readonly MobileDelivery[] | undefined, error: unknown, now = Date.now()): string | null | undefined {
  if (!memberId || !canUseDeliveryCache(error)) return null;
  return list === undefined ? undefined : list.find(delivery => sharesPosition(delivery, now))?.id ?? null;
}
