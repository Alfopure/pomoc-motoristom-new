import { SimulatedFleetLocationProvider } from "./simulated-provider";
import type { FleetLocationSeed } from "./simulated-provider";
import type { FleetLocationProvider } from "./types";

export function createFleetLocationProvider(assets: readonly FleetLocationSeed[]): FleetLocationProvider {
  return new SimulatedFleetLocationProvider(assets);
}

export type { FleetLocationProvider, FleetPositionUpdate } from "./types";
export type { FleetLocationSeed } from "./simulated-provider";
