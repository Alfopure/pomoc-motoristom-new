export const MAX_ROUTE_INTERMEDIATES = 25;

export type DrivingRouteResult = {
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
  calculatedAt: string;
  provider: "google-routes";
};

export function isDrivingRouteResult(value: unknown): value is DrivingRouteResult {
  if (!value || typeof value !== "object") return false;
  const route = value as Partial<DrivingRouteResult>;
  return route.provider === "google-routes"
    && typeof route.distanceMeters === "number" && Number.isFinite(route.distanceMeters) && route.distanceMeters >= 0
    && typeof route.durationSeconds === "number" && Number.isFinite(route.durationSeconds) && route.durationSeconds >= 0
    && typeof route.encodedPolyline === "string" && route.encodedPolyline.length > 0
    && typeof route.calculatedAt === "string" && Number.isFinite(Date.parse(route.calculatedAt));
}

export function formatDrivingDistance(meters: number) {
  return `${new Intl.NumberFormat("sk-SK", { maximumFractionDigits: 1 }).format(meters / 1000)} km`;
}

export function formatDrivingDuration(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}
