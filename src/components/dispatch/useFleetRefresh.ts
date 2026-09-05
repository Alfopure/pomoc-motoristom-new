"use client";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DispatchData } from "@/data/dispatch-types";
import { isFreshFleetTimestamp } from "@/lib/fleet-observation";

export function ageFleetData(data: DispatchData): DispatchData {
  return { ...data, commanderVehicles: (data.commanderVehicles ?? []).map((vehicle) => ({ ...vehicle,
    position: vehicle.position ? { ...vehicle.position, stale: !isFreshFleetTimestamp(vehicle.position.gpsTime) } : undefined,
  })), fleetAssets: data.fleetAssets.map((asset) => ({ ...asset,
    gps: asset.gps ? { ...asset.gps, stale: !isFreshFleetTimestamp(asset.gps.positionTime) } : undefined,
    occupancy: asset.swhouse && !isFreshFleetTimestamp(asset.swhouse.checkedAt) ? "stale" : asset.occupancy,
  })) };
}

export function mergeFleetData(current: DispatchData, incoming: DispatchData): DispatchData {
  // Never overwrite a case, task, call or notification edited while the vendor request was running.
  return ageFleetData({ ...current, fleetAssets: incoming.fleetAssets, fleetProviderVehicles: incoming.fleetProviderVehicles,
    commanderVehicles: incoming.commanderVehicles, commanderGpsLastSuccessAt: incoming.commanderGpsLastSuccessAt,
    commanderGpsLatestRunAt: incoming.commanderGpsLatestRunAt, commanderGpsLatestStatus: incoming.commanderGpsLatestStatus,
    integrations: [...current.integrations.filter((integration) => !["commander", "client_vehicle_db", "fleet"].includes(integration.provider)),
      ...incoming.integrations.filter((integration) => ["commander", "client_vehicle_db", "fleet"].includes(integration.provider))],
  });
}

export function useFleetRefresh(enabled: boolean, setData: Dispatch<SetStateAction<DispatchData>>) {
  const running = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setRefreshing(true);
    setData(ageFleetData);
    try {
      const response = await fetch("/api/integrations/fleet/refresh", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(305_000) });
      const body = await response.json();
      if (!response.ok || !body.dispatchData) throw new Error("Obnova je nedostupná; zobrazujú sa posledné uložené údaje.");
      setData((current) => mergeFleetData(current, body.dispatchData));
      setRefreshMessage(body.summary?.warnings?.join(" ") || (body.summary?.skipped ? "Zobrazené posledné údaje; ďalšia spoločná obnova je do minúty." : null));
    } catch {
      setRefreshMessage("Obnova je nedostupná; zobrazujú sa posledné uložené údaje.");
    } finally { running.current = false; setRefreshing(false); }
  }, [setData]);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (document.visibilityState === "visible") void refresh(); };
    const initial = window.setTimeout(tick, 800);
    const interval = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); document.removeEventListener("visibilitychange", tick); };
  }, [enabled, refresh]);
  return { refresh, refreshing, refreshMessage };
}
