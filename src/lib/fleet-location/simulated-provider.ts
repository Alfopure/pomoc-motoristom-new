import type { FleetAsset, GeoPoint } from "@/domain/types";
import type { FleetLocationProvider, FleetPositionUpdate } from "./types";

export type FleetLocationSeed = Pick<FleetAsset, "id" | "kind" | "lastSeen" | "point">;

type SimulatedFleetLocationOptions = {
  enableMovement?: boolean;
};

export class SimulatedFleetLocationProvider implements FleetLocationProvider {
  readonly source = "simulated";

  constructor(
    private readonly assets: readonly FleetLocationSeed[],
    private readonly options: SimulatedFleetLocationOptions = {},
  ) {}

  subscribe(onUpdate: (updates: FleetPositionUpdate[]) => void) {
    onUpdate(this.assets.map((asset) => ({ assetId: asset.id, point: pointForAsset(asset.point, this.options), lastSeen: asset.lastSeen })));
    return () => {};
  }
}

function pointForAsset(point: GeoPoint, options: SimulatedFleetLocationOptions): GeoPoint {
  if (!options.enableMovement) {
    return point;
  }

  return point;
}
