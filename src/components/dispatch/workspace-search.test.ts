import { describe, expect, it } from "vitest";
import { dispatchCases, fleetAssets } from "@/mock/seed";
import { fleetWidgetStatus, normalizeWorkspaceSearch, searchWorkspace } from "./workspace-search";

describe("workspace search", () => {
  it("normalizes plates, phone punctuation and accents", () => {
    expect(normalizeWorkspaceSearch("BA-123 XY")).toBe("ba123xy");
    expect(normalizeWorkspaceSearch("Štefánik +421 (900) 123")).toBe("stefanik421900123");
  });
  it("returns a case's identity by its contact and plate", () => {
    const item = dispatchCases[0];
    expect(searchWorkspace(item.vehicle.licensePlate, dispatchCases, [], []).some(result => result.caseId === item.id && result.kind === "case")).toBe(true);
    expect(searchWorkspace(item.contact.phone, dispatchCases, [], []).some(result => result.id === item.id)).toBe(true);
  });
  it("distinguishes available, occupied, stale and missing verification", () => {
    const asset = { ...fleetAssets[0], kind: "replacement_car" as const, status: "available" as const };
    expect(fleetWidgetStatus({ ...asset, occupancy: undefined })).toContain("neoverená");
    expect(fleetWidgetStatus({ ...asset, occupancy: "stale" })).toContain("neaktuálna");
    expect(fleetWidgetStatus({ ...asset, occupancy: "occupied" })).toBe("Obsadené");
    expect(fleetWidgetStatus({ ...asset, occupancy: "free" })).toBe("Voľné");
  });
  it("does not search private notes or inactive contacts", () => {
    expect(searchWorkspace("hidden", [], [{ id: "a", kind: "assistance", name: "hidden", active: false, createdAt: "", updatedAt: "" }], [])).toEqual([]);
    expect(searchWorkspace("", dispatchCases, [], fleetAssets)).toEqual([]);
  });
});
