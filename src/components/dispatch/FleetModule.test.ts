import { describe, expect, it } from "vitest";
import type { FleetAsset } from "@/domain/types";
import { assetToDraft } from "./FleetModule";

function asset(assignedDriverPhone: string): FleetAsset {
  return {
    id: "fleet-1",
    kind: "tow_truck",
    label: "Test tow truck",
    licensePlate: "XX000XX",
    status: "available",
    branchId: "branch-1",
    point: { lat: 48.15, lng: 17.12 },
    lastSeen: "2026-09-28T00:00:00Z",
    capabilities: [],
    assignedDriverPhone,
  };
}

describe("fleet driver phone editor", () => {
  it("opens a stored digits-only international number in editable form", () => {
    const stored = asset("420777123456");
    expect(assetToDraft(stored, undefined, "tow").assignedDriverPhone).toBe("+420777123456");
    expect(stored.assignedDriverPhone).toBe("420777123456");
  });
});
