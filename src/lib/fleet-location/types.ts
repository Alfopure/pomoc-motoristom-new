import type { GeoPoint } from "@/domain/types";

export type FleetPositionUpdate = {
  assetId: string;
  point: GeoPoint;
  lastSeen: string;
};

export interface FleetLocationProvider {
  readonly source: "simulated" | "webdispecink" | "commander";
  subscribe(onUpdate: (updates: FleetPositionUpdate[]) => void): () => void;
}
