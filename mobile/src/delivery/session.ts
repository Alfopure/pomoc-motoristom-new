import { useEffect, useLayoutEffect, useMemo } from "react";
import { randomUUID } from "expo-crypto";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobileDelivery, MobileFieldMe } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import { createDeliveryApi, type DeliveryApi } from "./api";
import { canUseDeliveryCache } from "./model";
import { deliveryMember, deliverySharing } from "./access";
import { DeliveryCommands } from "./commands";
import { createDeliveryCommandStorage } from "./command-storage";
import { createLocationSharing } from "./native-sharing";
import type { LocationSharing } from "./sharing";

/** The module Pristavenia of the signed-in person: their deliveries and the sharing
 * of their position. It lives as long as the account, not as a screen, so the
 * position keeps going while they work in another module. */
export type DeliverySession = {
  api: DeliveryApi; key: readonly string[];
  me: UseQueryResult<MobileFieldMe>; memberId: string | null;
  list: UseQueryResult<MobileDelivery[]>; location: LocationSharing;
  commands: DeliveryCommands | null; error: unknown; refresh: () => void;
};
/** The server said this account has no Pristavenia here (no role, or switched off). */
export function deliveryRefused(error: unknown): boolean {
  return error instanceof MobileApiError && (error.status === 403 || error.status === 503 && error.code === "delivery_unavailable");
}

export function useDeliverySession({ config, client, userId, liveUser, active, enabled, writable }: {
  config: MobileConfig; client: SupabaseClient; userId: string; liveUser: () => string | null; active: boolean; enabled: boolean; writable: boolean;
}): DeliverySession {
  const api = useMemo(() => createDeliveryApi(config, async () => {
    if (liveUser() !== userId) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
    const { data } = await client.auth.getSession();
    return liveUser() === userId && data.session?.user.id === userId ? data.session.access_token : null;
  }, fetch, () => liveUser() === userId), [config, client, userId, liveUser]);
  const key = useMemo(() => ["mobile", config.environment, userId, "field"], [config.environment, userId]);
  // Asked rarely: most dispatchers have no deliveries, and production has them off.
  const me = useQuery({ queryKey: [...key, "me"], queryFn: ({ signal }) => api.me(signal), enabled, staleTime: 600_000,
    retry: (count, error) => count < 1 && !deliveryRefused(error) && !(error instanceof MobileApiError && [401, 403, 409, 502].includes(error.status)),
    refetchInterval: query => !active ? false : query.state.error && deliveryRefused(query.state.error) ? 1_800_000 : 600_000 });
  // A refusal (role removed, deliveries switched off) ends Pristavenia, even with an older answer cached.
  const refused = me.isError && deliveryRefused(me.error);
  const verifiedMember = enabled ? deliveryMember(me.data, me.error) : null;
  const location = useMemo(() => createLocationSharing(api, config), [api, config]);
  useEffect(() => () => location.dispose(), [location]);
  const list = useQuery({ queryKey: [...key, "deliveries"], enabled: enabled && Boolean(verifiedMember), queryFn: ({ signal }) => api.list(signal),
    refetchInterval: active ? 30_000 : false });
  const memberId = enabled ? deliveryMember(me.data, me.error, list.error) : null;
  useEffect(() => { location.setMember(memberId); }, [location, memberId]);
  const commands = useMemo(() => memberId ? new DeliveryCommands(createDeliveryCommandStorage(), {
    environment: config.environment, apiOrigin: config.apiOrigin, projectUrl: config.supabaseUrl, userId, memberId,
  }, api, { current: () => liveUser() === userId, uuid: randomUUID }) : null, [config, userId, memberId, api, liveUser]);
  useLayoutEffect(() => { commands?.setActive(writable); return () => { commands?.setActive(false); }; }, [commands, writable]);
  useEffect(() => { if (commands && writable) void commands.load(); }, [commands, writable]);
  useEffect(() => () => commands?.dispose(), [commands]);
  // A position still being sent for another account, or for nobody, stops here.
  const settled = me.isSuccess || refused || me.isError && !canUseDeliveryCache(me.error);
  useEffect(() => { if (settled) void location.reconcile(memberId); }, [settled, memberId, location]);
  // The delivery this pristavovač took. Until the list loads, nothing changes. Each
  // fresh list checks again, so sending that stopped on its own starts again.
  const sharing = me.isPending ? undefined : deliverySharing(memberId, list.data, list.error);
  const checked = list.dataUpdatedAt;
  useEffect(() => {
    if (sharing === undefined) return;
    // Expo Go sends only while the app is open; the native app also in the background.
    void location.follow(location.mode === "foreground" && !active ? null : sharing);
  }, [location, active, sharing, checked]);
  return { api, key, me, memberId, list, location, commands, error: me.error ?? list.error,
    refresh: () => { void me.refetch(); if (me.data) void list.refetch(); } };
}
