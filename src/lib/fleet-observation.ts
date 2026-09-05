export type OccupancyObservation = {
  state: "free" | "occupied";
  checkedAt: string;
  observedSince: string;
};

export const FLEET_FRESHNESS_MS = 10 * 60_000;

export function isFreshFleetTimestamp(value: string | null | undefined, now = Date.now()): boolean {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp <= now + 60_000 && now - timestamp <= FLEET_FRESHNESS_MS;
}

export function nextOccupancyObservation(
  previous: unknown,
  state: OccupancyObservation["state"],
  checkedAt: string,
): OccupancyObservation {
  const prior = previous && typeof previous === "object" ? previous as Partial<OccupancyObservation> : null;
  const now = Date.parse(checkedAt);
  const continuous = prior?.state === state
    && isFreshFleetTimestamp(prior.checkedAt, now)
    && Date.parse(prior.checkedAt ?? "") <= now
    && Number.isFinite(Date.parse(prior.observedSince ?? ""))
    && Date.parse(prior.observedSince!) <= Date.parse(prior.checkedAt!);
  return { state, checkedAt, observedSince: continuous ? prior!.observedSince! : checkedAt };
}

export function validFleetPoint(point: { lat: number; lng: number } | undefined): boolean {
  return !!point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180
    && !(point.lat === 0 && point.lng === 0);
}

export function acceptFleetPosition(point: { lat: number; lng: number } | undefined, measuredAt: string | undefined, previousAt?: string | null, now = Date.now()) {
  const measured = Date.parse(measuredAt ?? "");
  const previous = Date.parse(previousAt ?? "");
  return validFleetPoint(point) && Number.isFinite(measured) && measured <= now + 60_000
    && (!Number.isFinite(previous) || measured >= previous);
}

/** Allowlist of actual position fields. Authentication/response headers never reach the browser. */
export function fleetTelemetryDetails(value: unknown): Record<string, string | number | boolean | null> {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const keys = ["vehicleId", "gpsTime", "gpsLat", "gpsLon", "gpsLAlt", "gpsAzimut", "gpsSpeed", "carIgnition", "voltage",
    "canSpeed", "canThrottle", "canConsumed", "canTankValue", "canRpm", "canEngineHours", "canOdometer", "temperatures",
    "carid", "positiontime", "localpostime", "km", "speed", "fueltank", "Location_city", "Location_state"];
  return Object.fromEntries(keys.flatMap((key) => {
    const entry = raw[key];
    if (entry === undefined) return [];
    if (entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") return [[key, entry]];
    return Array.isArray(entry) ? [[key, JSON.stringify(entry).slice(0, 2048)]] : [];
  }));
}
