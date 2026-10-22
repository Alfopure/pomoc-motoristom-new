import { useEffect, useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobileDelivery, MobileFieldMe } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import { createDeliveryApi, type DeliveryApi } from "./api";
import { sharesPosition } from "./model";
import { createLocationSharing } from "./native-sharing";
import type { LocationSharing } from "./sharing";

/** The module Pristavenia of the signed-in person: their deliveries and the sharing
 * of their position. It lives as long as the account, not as a screen, so the
 * position keeps going while they work in another module. */
export type DeliverySession = {
  api: DeliveryApi; key: readonly string[];
  me: UseQueryResult<MobileFieldMe>; memberId: string | null;
  list: UseQueryResult<MobileDelivery[]>; location: LocationSharing;
};
/** The server said this account has no Pristavenia here (no role, or switched off). */
export function deliveryRefused(error: unknown): boolean {
  return error instanceof MobileApiError && (error.status === 403 || error.status === 503 && error.code === "delivery_unavailable");
}

export function useDeliverySession({ config, client, userId, liveUser, active, enabled }: {
  config: MobileConfig; client: SupabaseClient; userId: string; liveUser: () => string | null; active: boolean; enabled: boolean;
}): DeliverySession {
  const api = useMemo(() => createDeliveryApi(config, async () => {
    if (liveUser() !== userId) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
    const { data } = await client.auth.getSession();
    return liveUser() === userId && data.session?.user.id === userId ? data.session.access_token : null;
  }), [config, client, userId, liveUser]);
  const key = useMemo(() => ["mobile", config.environment, userId, "field"], [config.environment, userId]);
  const me = useQuery({ queryKey: [...key, "me"], queryFn: ({ signal }) => api.me(signal), enabled, staleTime: 60_000,
    refetchInterval: active ? 300_000 : false });
  const memberId = me.data?.memberId ?? null;
  const location = useMemo(() => createLocationSharing(api, config), [api, config]);
  useEffect(() => () => location.dispose(), [location]);
  useEffect(() => { location.setMember(memberId); }, [location, memberId]);
  const list = useQuery({ queryKey: [...key, "deliveries"], enabled: enabled && Boolean(memberId), queryFn: ({ signal }) => api.list(signal),
    refetchInterval: active ? 30_000 : false });
  // A position still being sent for another account, or for nobody, stops here.
  const settled = me.isSuccess || me.isError && deliveryRefused(me.error);
  useEffect(() => { if (settled) void location.reconcile(memberId); }, [settled, memberId, location]);
  // The delivery this pristavovač took. Until the list loads, nothing changes.
  const sharing = list.data === undefined ? undefined : list.data.find(delivery => sharesPosition(delivery))?.id ?? null;
  useEffect(() => {
    if (sharing === undefined) return;
    // Expo Go sends only while the app is open; the native app also in the background.
    void location.follow(location.mode === "foreground" && !active ? null : sharing);
  }, [location, active, sharing]);
  return { api, key, me, memberId, list, location };
}
