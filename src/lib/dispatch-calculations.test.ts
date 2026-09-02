import { describe, expect, it } from "vitest";

import type { FleetAsset } from "@/domain/types";
import { branches, dispatchCases, fleetAssets, priceRules } from "@/mock/seed";
import { findNearestAsset, formatTime, recommendAssetForCase } from "./dispatch-calculations";
import { createDispatchMapModel, createDispatchOverviewMapModel } from "./map-adapter";

const caseItem = dispatchCases[0];
const baseCar = fleetAssets.find((asset) => asset.kind === "replacement_car");
const pickup = caseItem.pickup!;

describe("Slovak operational time formatting", () => {
  it("does not depend on the server or browser timezone", () => {
    expect(formatTime("2026-07-22T16:35:00.000Z")).toBe("18:35");
  });
});

describe("recommendAssetForCase — SWHouse obsadenosť (rented) penalizuje výber (T2)", () => {
  if (!baseCar) {
    throw new Error("seed neobsahuje náhradné vozidlo");
  }

  it("nikdy neodporučí obsadené (rented) auto pred voľným pri inak rovnakom aute", () => {
    const free: FleetAsset = { ...baseCar, id: "free-car", status: "available", occupancy: "free", point: pickup };
    const rented: FleetAsset = { ...baseCar, id: "rented-car", status: "rented", occupancy: "occupied", point: pickup };
    const recommendation = recommendAssetForCase(caseItem, [rented, free], "replacement_car");
    expect(recommendation?.asset.id).toBe("free-car");
  });

  it("obsadené SWHouse auto nikdy automaticky neodporučí ani keď je jediné", () => {
    const rented = recommendAssetForCase(
      caseItem,
      [{ ...baseCar, id: "r", status: "rented", occupancy: "occupied", point: pickup }],
      "replacement_car",
    );
    expect(rented).toBeUndefined();
  });

  it("nearest fallback nikdy potichu nevyberie jediné obsadené auto", () => {
    const occupied: FleetAsset = {
      ...baseCar,
      id: "occupied-only",
      status: "rented",
      occupancy: "occupied",
      point: pickup,
    };
    expect(findNearestAsset(caseItem, [occupied])).toBeUndefined();
    const model = createDispatchMapModel(caseItem, branches, [occupied], priceRules[0]);
    expect(model.nearestAsset).toBeUndefined();
    expect(model.routePlan?.segments.some((segment) => segment.id === "asset-to-pickup")).toBe(false);
  });

  it("neoverené alebo staré dáta neporazia overene voľné auto", () => {
    const verified: FleetAsset = { ...baseCar, id: "verified", status: "available", occupancy: "free", point: { ...pickup, lat: pickup.lat + 0.1 } };
    const stale: FleetAsset = { ...baseCar, id: "stale", status: "available", occupancy: "stale", point: pickup };
    const unverified: FleetAsset = { ...baseCar, id: "unverified", status: "available", occupancy: "unverified", point: pickup };
    const recommendation = recommendAssetForCase(caseItem, [stale, unverified, verified], "replacement_car");
    expect(recommendation?.asset.id).toBe("verified");
  });
});

describe("empty case map and routing", () => {
  it("keeps the overview map useful when there are no cases", () => {
    const model = createDispatchOverviewMapModel(branches);

    expect(model.available).toBe(true);
    expect(model.route).toBeNull();
    expect(model.routePlan).toBeNull();
    expect(model.markers).toHaveLength(branches.length);
    expect(model.markers.every((marker) => marker.kind === "branch")).toBe(true);
    expect(model.center).not.toBeNull();
  });

  it("does not invent a pickup, route, branch, asset, ETA or price", () => {
    const emptyCase = {
      ...caseItem,
      pickup: undefined,
      destination: undefined,
      branchId: undefined,
      selectedAssetId: undefined,
      priceRuleId: undefined,
    };

    expect(findNearestAsset(emptyCase, fleetAssets)).toBeUndefined();
    expect(recommendAssetForCase(emptyCase, fleetAssets)).toBeUndefined();

    const model = createDispatchMapModel(emptyCase, branches, fleetAssets, priceRules[0]);
    expect(model).toMatchObject({
      available: false,
      unavailableReason: "missing_pickup",
      center: null,
      route: null,
      routePlan: null,
      nearestBranch: undefined,
      nearestAsset: undefined,
      price: null,
      markers: [],
    });
  });

  it("keeps a real pickup visible but does not invent a required tow destination", () => {
    const missingDestination = { ...caseItem, jobTypes: ["tow" as const], destination: undefined };
    const model = createDispatchMapModel(missingDestination, branches, fleetAssets, priceRules[0]);

    expect(model.available).toBe(true);
    expect(model.unavailableReason).toBe("missing_destination");
    expect(model.route).toBeNull();
    expect(model.routePlan).toBeNull();
    expect(model.price).toBeNull();
    expect(model.markers.filter((marker) => marker.kind === "pickup")).toHaveLength(1);
    expect(model.markers.filter((marker) => marker.kind === "destination")).toHaveLength(0);
  });
});
