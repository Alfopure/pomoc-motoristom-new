import type { QueryClient } from "@tanstack/react-query";
import type { MobileFieldCash, MobileTowingOrder } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import { newerCash, newerTowing } from "./model";

/** This barrier completes before the outbox forgets an acknowledged financial intent. */
export async function cacheWorkReceipt(client: QueryClient, scope: readonly string[], memberId: string,
  receipt: { kind: "towing"; id: string; order: MobileTowingOrder | null; cash?: MobileFieldCash } | { kind: "cash"; cash: MobileFieldCash }, current: () => boolean) {
  const cashKey = [...scope, "work-cash", memberId];
  const orderKey = receipt.kind === "towing" ? [...scope, "towing", receipt.id] : null;
  await Promise.all([client.cancelQueries({ queryKey: cashKey, exact: true }), ...(orderKey ? [client.cancelQueries({ queryKey: orderKey, exact: true })] : [])]);
  if (!current()) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
  if (receipt.kind === "towing" && receipt.order && orderKey) client.setQueryData<MobileTowingOrder>(orderKey, previous => newerTowing(previous, receipt.order!));
  if (receipt.cash) client.setQueryData<MobileFieldCash>(cashKey, previous => newerCash(previous, receipt.cash!));
}
