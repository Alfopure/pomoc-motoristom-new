"use client";
import { requestFleetRefresh } from "./fleet-refresh-client";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DispatchData, FleetData } from "@/data/dispatch-types";
import { isFreshFleetTimestamp } from "@/lib/fleet-observation";

export function ageFleetData(data: DispatchData): DispatchData {
  return { ...data, commanderVehicles: (data.commanderVehicles ?? []).map((vehicle) => ({ ...vehicle,
    position: vehicle.position ? { ...vehicle.position, stale: !isFreshFleetTimestamp(vehicle.position.gpsTime) } : undefined,
  })), fleetAssets: data.fleetAssets.map((asset) => ({ ...asset,
    gps: asset.gps ? { ...asset.gps, stale: !isFreshFleetTimestamp(asset.gps.positionTime) } : undefined,
    occupancy: asset.swhouse && !isFreshFleetTimestamp(asset.swhouse.checkedAt) ? "stale" : asset.occupancy,
  })) };
}

export function mergeFleetData(current: DispatchData, incoming: FleetData): DispatchData {
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
      const body = await requestFleetRefresh();
      setData((current) => mergeFleetData(current, body.fleetData));
      setRefreshMessage(body.summary?.warnings?.join(" ") || (body.summary?.skipped ? "Zobrazené posledné údaje; ďalšia spoločná obnova je do minúty." : null));
    } catch {
      setRefreshMessage("Obnova je nedostupná; zobrazujú sa posledné uložené údaje.");
    } finally { running.current = false; setRefreshing(false); }
  }, [setData]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let polling = false;
    let timer: number;
    const tick = async () => {
      window.clearTimeout(timer);
      if (stopped || polling) return;
      polling = true;
      try { if (document.visibilityState === "visible") await refresh(); } finally { polling = false; }
      if (!stopped) timer = window.setTimeout(tick, 60_000 + Math.random() * 6_000);
    };
    const wake = () => { if (document.visibilityState === "visible") void tick(); };
    timer = window.setTimeout(tick, 800);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); window.removeEventListener("focus", wake); };
  }, [enabled, refresh]);
  return { refresh, refreshing, refreshMessage };
}
