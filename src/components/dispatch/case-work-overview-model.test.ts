import { describe, expect, it } from "vitest";
import type { Operation } from "@/domain/operations";
import type { TowingOrder } from "@/domain/towing/types";
import type { WorkRequest } from "@/domain/work-groups";
import { caseWorkOverviewItems } from "./case-work-overview-model";
const operation = (change: Partial<Operation> = {}): Operation =>
  ({
    id: "operation-1",
    kind: "tow",
    owner: "towing_order",
    ownerId: "tow-1",
    status: "assigned",
    from: "Nakládka",
    to: "Servis",
    vehicle: "Vozidlo",
    scheduledAt: "2026-11-05T12:00:00Z",
    startedAt: null,
    assignee: "Vodič",
    ...change,
  }) as Operation;
const order = (change: Partial<TowingOrder> = {}): TowingOrder =>
  ({
    id: "tow-1",
    number: "Z-00001",
    driverId: "driver-1",
    workStatus: "assigned",
    fields: {
      serviceType: "tow",
      subjectType: "vehicle",
      subjectDescription: "Vozidlo",
      pickup: "Nakládka",
      destination: "Servis",
    },
    ...change,
  }) as TowingOrder;
const request = (change: Partial<WorkRequest> = {}): WorkRequest =>
  ({
    id: "request-1",
    kind: "tow",
    groupName: "Pobočka Žilina",
    status: "assigned",
    pickup: "Nakládka",
    destination: "Servis",
    dueAt: null,
    vehicle: null,
    claimedByName: null,
    execution: {
      operationId: "operation-1",
      owner: "towing_order",
      ownerId: "tow-1",
      status: "assigned",
      assignee: "Vodič",
      scheduledAt: null,
      startedAt: null,
    },
    ...change,
  }) as WorkRequest;
describe("case work overview identity", () => {
  it("rejects invalid calendar timestamps rather than showing another day", () => {
    const row = caseWorkOverviewItems({
      orders: [
        order({
          fields: { ...order().fields, plannedAt: "2026-02-30T12:00:00Z" },
        }),
      ],
    })[0];
    expect(row.time).toBeNull();
  });
  it("shows one execution for an order, its logistics projection and a materialized branch request", () => {
    const rows = caseWorkOverviewItems({
      orders: [order()],
      operations: [operation()],
      requests: [request()],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "tow",
      title: "Z-00001",
      recipient: "Vodič",
      branch: "Pobočka Žilina",
    });
  });
  it("keeps authorized towing projections when office data is unavailable", () => {
    const rows = caseWorkOverviewItems({
      operations: [operation()],
      requests: [request()],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "operation",
      kind: "tow",
      branch: "Pobočka Žilina",
    });
  });
  it("preserves distinct same-kind executions and unmatched queues", () => {
    const rows = caseWorkOverviewItems({
      orders: [order(), order({ id: "tow-2", number: "Z-00002" })],
      operations: [operation()],
      requests: [
        request({ id: "request-2", status: "queued", execution: null }),
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.key)).toEqual(
      expect.arrayContaining(["tow:tow-1", "tow:tow-2", "request:request-2"]),
    );
  });
  it("deduplicates by towing owner even when its projection is on another page", () => {
    expect(
      caseWorkOverviewItems({ orders: [order()], requests: [request()] }),
    ).toHaveLength(1);
  });
  it("uses the real schedule instead of an old assignment timestamp", () => {
    const row = caseWorkOverviewItems({
      orders: [
        order({
          fields: {
            ...order().fields,
            plannedAt: "2026-11-05T12:00:00Z",
            startedAt: "2026-11-05T10:00:00Z",
            startSource: "assignment",
          },
        }),
      ],
    })[0];
    expect(row.time).toBe("2026-11-05T12:00:00Z");
    expect(row.timeLabel).toBe("Dohodnutý termín");
  });
  it("does not fabricate a time when only assignment provenance exists", () => {
    const row = caseWorkOverviewItems({
      orders: [
        order({
          fields: {
            ...order().fields,
            startedAt: "2026-11-05T10:00:00Z",
            startSource: "assignment",
          },
        }),
      ],
    })[0];
    expect(row.time).toBeNull();
  });
  it("groups collections and transfers separately from delivery and towing", () => {
    const rows = caseWorkOverviewItems({
      operations: [
        operation({
          id: "collection-1",
          owner: "logistics",
          ownerId: "collection-1",
          kind: "collection",
        }),
        operation({
          id: "delivery-1",
          owner: "logistics",
          ownerId: "delivery-1",
          kind: "delivery",
        }),
      ],
    });
    expect(rows.map((r) => r.kind)).toEqual(["collection", "delivery"]);
  });
  it("does not use an assigned branch towing timestamp as actual departure", () => {
    const row = caseWorkOverviewItems({
      requests: [
        request({
          execution: {
            ...request().execution!,
            status: "assigned",
            startedAt: "2026-11-05T10:00:00Z",
            scheduledAt: null,
          },
        }),
      ],
    })[0];
    expect(row.time).toBeNull();
  });
});
