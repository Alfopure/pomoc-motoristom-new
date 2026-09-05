import type { Branch, DispatchCase, FleetAsset, GeoPoint, PriceRule } from "@/domain/types";
import {
  calculatePrice,
  calculateRoute,
  calculateRoutePlan,
  calculateUnassignedRoutePlan,
  distanceKm,
  findNearestAsset,
  findNearestBranch,
} from "./dispatch-calculations";
import { requiresTowDestination } from "@/domain/case-card";

export type DispatchMapModel = {
  available: boolean;
  unavailableReason?: "missing_pickup" | "missing_destination" | "missing_branch";
  center: GeoPoint | null;
  route: ReturnType<typeof calculateRoute>;
  routePlan: ReturnType<typeof calculateRoutePlan>;
  nearestBranch: ReturnType<typeof findNearestBranch>;
  nearestAsset: ReturnType<typeof findNearestAsset>;
  price: ReturnType<typeof calculatePrice> | null;
  markers: Array<{
    id: string;
    label: string;
    point: GeoPoint;
    kind: "pickup" | "destination" | "branch" | "tow" | "replacement_car";
    asset?: {
      type: FleetAsset["kind"];
      status: FleetAsset["status"];
      gpsSource?: string;
      gpsTime?: string;
      speedKph?: number;
      stale?: boolean;
    };
  }>;
};

export function createDispatchMapModel(
  caseItem: DispatchCase,
  branches: Branch[],
  assets: FleetAsset[],
  priceRule?: PriceRule,
): DispatchMapModel {
  if (!caseItem.pickup) {
    return {
      available: false,
      unavailableReason: "missing_pickup",
      center: null,
      route: null,
      routePlan: null,
      nearestBranch: undefined,
      nearestAsset: undefined,
      price: null,
      markers: [],
    };
  }

  const pickup = caseItem.pickup;
  const route = calculateRoute(caseItem);
  const nearestBranch = findNearestBranch(caseItem, branches);
  const selectedAsset = caseItem.selectedAssetId ? assets.find((asset) => asset.id === caseItem.selectedAssetId) : undefined;
  const nearestAsset = selectedAsset
    ? selectedAsset.positionKnown === false ? undefined : { asset: selectedAsset, distance: distanceKm(pickup, selectedAsset.point) }
    : findNearestAsset(caseItem, assets);
  const routePlan = nearestBranch
    ? nearestAsset
      ? calculateRoutePlan(caseItem, nearestBranch.branch, nearestAsset.asset)
      : calculateUnassignedRoutePlan(caseItem, nearestBranch.branch)
    : null;
  const price = routePlan && priceRule ? calculatePrice(routePlan.totalOperationalKm, priceRule) : null;
  const needsDestination = requiresTowDestination(caseItem.jobTypes);
  const centerPoints = [
    ...(nearestAsset ? [nearestAsset.asset.point] : []),
    pickup,
    ...(nearestBranch ? [nearestBranch.branch.point] : []),
    ...(needsDestination && caseItem.destination ? [caseItem.destination] : []),
  ];

  return {
    available: true,
    unavailableReason: needsDestination && !caseItem.destination ? "missing_destination" : !nearestBranch ? "missing_branch" : undefined,
    center: {
      lat: centerPoints.reduce((total, point) => total + point.lat, 0) / centerPoints.length,
      lng: centerPoints.reduce((total, point) => total + point.lng, 0) / centerPoints.length,
    },
    route,
    routePlan,
    nearestBranch,
    nearestAsset,
    price,
    markers: [
      {
        id: `${caseItem.id}-pickup`,
        label: pickup.label,
        point: pickup,
        kind: "pickup",
      },
      ...(needsDestination && caseItem.destination
        ? [
            {
              id: `${caseItem.id}-destination`,
              label: caseItem.destination.label,
              point: caseItem.destination,
              kind: "destination" as const,
            },
          ]
        : []),
      ...branches.map((branch) => ({
        id: branch.id,
        label: branch.name,
        point: branch.point,
        kind: "branch" as const,
      })),
      ...assets.filter((asset) => asset.positionKnown !== false).map((asset) => ({
        id: asset.id,
        label: asset.label,
        point: asset.point,
        kind: asset.kind === "tow_truck" ? ("tow" as const) : ("replacement_car" as const),
        asset: {
          type: asset.kind,
          status: asset.status,
          gpsSource: asset.gps?.source,
          gpsTime: asset.gps?.positionTime,
          speedKph: asset.gps?.speedKph,
          stale: asset.gps?.stale,
        },
      })),
    ],
  };
}

export function createDispatchOverviewMapModel(branches: Branch[]): DispatchMapModel {
  const center = branches.length > 0
    ? {
        lat: branches.reduce((total, branch) => total + branch.point.lat, 0) / branches.length,
        lng: branches.reduce((total, branch) => total + branch.point.lng, 0) / branches.length,
      }
    : null;

  return {
    available: true,
    center,
    route: null,
    routePlan: null,
    nearestBranch: undefined,
    nearestAsset: undefined,
    price: null,
    markers: branches.map((branch) => ({
      id: branch.id,
      label: branch.name,
      point: branch.point,
      kind: "branch" as const,
    })),
  };
}
