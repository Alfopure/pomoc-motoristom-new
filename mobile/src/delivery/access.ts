import type { MobileDelivery, MobileFieldMe } from "../../../src/lib/mobile-api";
import { canUseDeliveryCache, sharesPosition } from "./model";

/** A stale identity is useful through a connection failure. A refusal or an
 * untrusted identity/list must end access and stop using old tracking state. */
export function deliveryMember(me: MobileFieldMe | undefined, error: unknown, listError?: unknown): string | null {
  return canUseDeliveryCache(error) && canUseDeliveryCache(listError) ? me?.memberId ?? null : null;
}
export function deliverySharing(memberId: string | null, list: readonly MobileDelivery[] | undefined, error: unknown, now = Date.now()): string | null | undefined {
  if (!memberId || !canUseDeliveryCache(error)) return null;
  return list === undefined ? undefined : list.find(delivery => sharesPosition(delivery, now))?.id ?? null;
}
