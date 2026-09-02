"use client";

import { useEffect, useMemo, useState } from "react";
import type { FleetAsset, GeoPoint } from "@/domain/types";
import { createFleetLocationProvider } from "@/lib/fleet-location";

export type FleetPositionOverride = {
  point: GeoPoint;
  lastSeen: string;
};

export function useFleetPositions(assets: FleetAsset[]) {
  const provider = useMemo(() => createFleetLocationProvider(assets), [assets]);
  const [positionOverrides, setPositionOverrides] = useState<Map<string, FleetPositionOverride>>(() => new Map());

  useEffect(
    () =>
      provider.subscribe((updates) => {
        setPositionOverrides((current) => {
          const next = new Map(current);
          updates.forEach((update) => {
            next.set(update.assetId, { point: update.point, lastSeen: update.lastSeen });
          });
          return next;
        });
      }),
    [provider],
  );

  return positionOverrides;
}
