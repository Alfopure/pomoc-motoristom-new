import type { GeoPoint } from "@/domain/types";
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
    return Response.json({ error: "GOOGLE_MAPS_API_KEY is not configured." }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as RouteRequestBody | null;
  const validationError = validateRouteRequest(body);

  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 });
  }

  const response = await fetch(ROUTES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "routes.distanceMeters,routes.duration,routes.polyline,routes.legs.distanceMeters,routes.legs.duration,routes.legs.polyline",
    },
    body: JSON.stringify({
      computeAlternativeRoutes: false,
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
      routingPreference: "TRAFFIC_AWARE",
      polylineQuality: "HIGH_QUALITY",
      travelMode: "DRIVE",
      units: "METRIC",
    }),
  });

  const data = (await response.json().catch(() => null)) as GoogleRouteResponse | null;

  if (!response.ok) {
    return Response.json(
      { error: data?.error?.message ?? `Google Routes API failed with ${response.status}.` },
      { status: response.status },
    );
  }

  const route = data?.routes?.[0];

  if (!route?.distanceMeters || !route.duration) {
    return Response.json({ error: "Google Routes API returned no usable route." }, { status: 502 });
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
  });
}

function validateRouteRequest(body: RouteRequestBody | null) {
  if (!body) {
    return "Request body is required.";
  }

  if (!isGeoPoint(body.origin)) {
    return "origin must contain numeric lat/lng.";
  }

  if (!isGeoPoint(body.destination)) {
    return "destination must contain numeric lat/lng.";
  }

  if (body.intermediates && !body.intermediates.every(isGeoPoint)) {
    return "intermediates must contain numeric lat/lng.";
  }

  return null;
}

function isGeoPoint(value: GeoPoint | undefined): value is GeoPoint {
  return typeof value?.lat === "number" && Number.isFinite(value.lat) && typeof value.lng === "number" && Number.isFinite(value.lng);
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
  return Number(duration.replace(/s$/, "")) || 0;
}
