"use client";

import { useMemo } from "react";
import type { FleetAsset, GeoPoint } from "@/domain/types";

export type FleetPositionOverride = {
  point: GeoPoint;
  lastSeen: string;
};

export function useFleetPositions(assets: FleetAsset[]) {
  // Server refresh supplies measured positions. A new snapshot also removes old/unlinked overrides.
  return useMemo(() => new Map(assets.filter((asset) => asset.positionKnown !== false)
    .map((asset) => [asset.id, { point: asset.point, lastSeen: asset.lastSeen }])), [assets]);
}
