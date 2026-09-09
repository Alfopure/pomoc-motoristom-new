import type { GeoPoint } from "@/domain/types";
import { MAX_ROUTE_INTERMEDIATES } from "@/lib/driving-route";
import { assertSameOriginRequest, requireDefaultMotoristOrgMember } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

type RouteRequestBody = {
  origin?: GeoPoint;
  destination?: GeoPoint;
  intermediates?: GeoPoint[];
};

type GoogleRouteResponse = {
  routes?: Array<{
    distanceMeters?: number;
    duration?: string;
    polyline?: {
      encodedPolyline?: string;
    };
    legs?: Array<{
      distanceMeters?: number;
      duration?: string;
      polyline?: {
        encodedPolyline?: string;
      };
    }>;
  }>;
  error?: {
    message?: string;
    status?: string;
  };
};

const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgMember();
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Route authorization failed:", error);
    return Response.json({ error: "Oprávnenie sa nepodarilo overiť." }, { status: 500 });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey || apiKey.startsWith("replace-with")) {
    return Response.json({ error: "Výpočet trasy momentálne nie je dostupný." }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as RouteRequestBody | null;
  const validationError = validateRouteRequest(body);

  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 });
  }

  try {
    const response = await fetch(ROUTES_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "routes.distanceMeters,routes.duration,routes.polyline,routes.legs.distanceMeters,routes.legs.duration,routes.legs.polyline",
      },
      body: JSON.stringify({
        computeAlternativeRoutes: false,
        // An omitted departureTime means now; preserve the user's waypoint order.
        optimizeWaypointOrder: false,
        destination: toWaypoint(body!.destination!),
        intermediates: body!.intermediates?.map(toWaypoint) ?? [],
        languageCode: "sk-SK",
        origin: toWaypoint(body!.origin!),
        regionCode: "sk",
        routeModifiers: {
          avoidFerries: false,
          avoidHighways: false,
          avoidTolls: false,
        },
        routingPreference: "TRAFFIC_AWARE_OPTIMAL",
        polylineQuality: "HIGH_QUALITY",
        travelMode: "DRIVE",
        units: "METRIC",
      }),
    });

    const data = (await response.json().catch(() => null)) as GoogleRouteResponse | null;

    if (!response.ok) {
      return Response.json(
        { error: "Trasu sa nepodarilo vypočítať. Skúste to o chvíľu znova." },
        { status: 502 },
      );
    }

    const route = data?.routes?.[0];

    if (!route || typeof route.distanceMeters !== "number" || !Number.isFinite(route.distanceMeters)
      || route.distanceMeters < 0 || !route.duration || !/^\d+(?:\.\d+)?s$/.test(route.duration)
      || !Number.isFinite(durationToSeconds(route.duration)) || typeof route.polyline?.encodedPolyline !== "string" || !route.polyline.encodedPolyline) {
      return Response.json({ error: "Medzi zadanými miestami sa nenašla prejazdná cesta. Skontrolujte aj body prejazdu." }, { status: 502 });
    }

    return Response.json({
      distanceMeters: route.distanceMeters,
      durationSeconds: durationToSeconds(route.duration),
      encodedPolyline: route.polyline?.encodedPolyline ?? null,
      legs:
        route.legs?.map((leg) => ({
          distanceMeters: leg.distanceMeters ?? 0,
          durationSeconds: durationToSeconds(leg.duration ?? "0s"),
          encodedPolyline: leg.polyline?.encodedPolyline ?? null,
        })) ?? [],
      provider: "google-routes",
      calculatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Výpočet trasy nie je dostupný alebo trvá príliš dlho. Skúste to znova." }, { status: 502 });
  }
}

function validateRouteRequest(body: RouteRequestBody | null) {
  if (!body) {
    return "Zadajte štart a cieľ trasy.";
  }

  if (!isGeoPoint(body.origin)) {
    return "Vyberte platné miesto štartu.";
  }

  if (!isGeoPoint(body.destination)) {
    return "Vyberte platný cieľ trasy.";
  }

  if (body.intermediates !== undefined && (!Array.isArray(body.intermediates)
    || body.intermediates.length > MAX_ROUTE_INTERMEDIATES || !body.intermediates.every(isGeoPoint))) {
    return `Zadajte najviac ${MAX_ROUTE_INTERMEDIATES} platných bodov prejazdu.`;
  }

  return null;
}

function isGeoPoint(value: unknown): value is GeoPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<GeoPoint>;
  return typeof point.lat === "number" && Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90
    && typeof point.lng === "number" && Number.isFinite(point.lng) && point.lng >= -180 && point.lng <= 180;
}

function toWaypoint(point: GeoPoint) {
  return {
    location: {
      latLng: {
        latitude: point.lat,
        longitude: point.lng,
      },
    },
  };
}

function durationToSeconds(duration: string) {
  return Number(duration.replace(/s$/, ""));
}
