import { describe, expect, it, vi } from "vitest";
import { createRoutePlannerStore } from "./route-planner-model";

const start = { label: "Bratislava", lat: 48.14, lng: 17.1 };
const end = { label: "Praha", lat: 50.08, lng: 14.43 };
const route = { distanceMeters: 420123, durationSeconds: 15300, encodedPolyline: "test", calculatedAt: "2026-09-10T12:00:00Z", provider: "google-routes" };
const response = (distanceMeters = route.distanceMeters) => new Response(JSON.stringify({ ...route, distanceMeters }), { status: 200 });

function fixture(fetchRoute = vi.fn<typeof fetch>(async () => response())) {
  const store = createRoutePlannerStore(fetchRoute);
  store.updatePlace(0, start, start.label); store.updatePlace(1, end, end.label);
  return { store, fetchRoute };
}

describe("shared route planner", () => {
  it("preserves raw queries and selected places across view subscriptions, without calculating", () => {
    const { store, fetchRoute } = fixture();
    const map = vi.fn();
    const unsubscribeMap = store.subscribe(map);
    store.updatePlace(1, null, "Praha unfinished street");
    unsubscribeMap();
    const widget = vi.fn();
    store.subscribe(widget);
    expect(store.getSnapshot().stops).toEqual([{ id: 0, place: start, query: start.label }, { id: 1, place: null, query: "Praha unfinished street" }]);
    expect(fetchRoute).not.toHaveBeenCalled();
    expect(widget).not.toHaveBeenCalled();
    store.reverse();
    expect(widget).toHaveBeenCalledOnce();
    expect(store.getSnapshot().stops[0].query).toBe("Praha unfinished street");
  });

  it("calculates only an explicitly requested complete route, shared by the next view", async () => {
    const { store, fetchRoute } = fixture();
    const unsubscribe = store.subscribe(vi.fn()); unsubscribe();
    expect(fetchRoute).not.toHaveBeenCalled();
    await store.calculate();
    expect(fetchRoute).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchRoute.mock.calls[0]![1]!.body as string)).toEqual({ origin: { lat: start.lat, lng: start.lng }, destination: { lat: end.lat, lng: end.lng }, intermediates: [] });
    store.subscribe(vi.fn());
    expect(store.getSnapshot().result?.distanceMeters).toBe(420123);
    expect(fetchRoute).toHaveBeenCalledOnce();
  });

  it("aborts an older calculation and ignores it even when transport resolves after the new one", async () => {
    const completions: ((value: Response) => void)[] = [];
    const fetchRoute = vi.fn<typeof fetch>(() => new Promise(resolve => { completions.push(resolve); }));
    const { store } = fixture(fetchRoute);
    const oldRequest = store.calculate();
    store.reverse();
    expect(fetchRoute.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    const newRequest = store.calculate();
    completions[1](response(20000)); await newRequest;
    completions[0](response(999999)); await oldRequest;
    expect(store.getSnapshot().result?.distanceMeters).toBe(20000);
    expect(store.getSnapshot().busy).toBe(false);
    expect(store.getSnapshot().error).toBe(null);
  });

  it("invalidates a completed route on raw edits and will not calculate an unselected address", async () => {
    const { store, fetchRoute } = fixture();
    await store.calculate();
    store.updatePlace(1, null, "new unfinished address");
    await store.calculate();
    expect(store.getSnapshot().result).toBe(null);
    expect(fetchRoute).toHaveBeenCalledOnce();
  });

  it("retains typed waypoint identity through reorder/reversal and prevents removing endpoints", () => {
    const { store } = fixture();
    store.addStop(); store.addStop();
    const [first, second] = store.getSnapshot().stops.slice(1, -1);
    store.updatePlace(first.id, null, "Wien partial"); store.updatePlace(second.id, null, "Brno partial");
    store.moveStop(2, -1);
    expect(store.getSnapshot().stops.map(stop => stop.query)).toEqual(["Bratislava", "Brno partial", "Wien partial", "Praha"]);
    store.removeStop(0);
    expect(store.getSnapshot().stops).toHaveLength(4);
    store.reverse(); store.removeStop(first.id);
    expect(store.getSnapshot().stops.map(stop => stop.query)).toEqual(["Praha", "Brno partial", "Bratislava"]);
  });

  it("cancels a departing session without accepting its late route result", async () => {
    let complete!: (value: Response) => void;
    const { store } = fixture(vi.fn<typeof fetch>(() => new Promise(resolve => { complete = resolve; })));
    const calculation = store.calculate();
    store.cancel();
    complete(response()); await calculation;
    expect(store.getSnapshot().result).toBe(null);
    expect(store.getSnapshot().busy).toBe(false);
  });

  it("reorders any selected point by stable identity and discards a stale route response", async () => {
    let complete!: (value: Response) => void;
    const { store } = fixture(vi.fn<typeof fetch>(() => new Promise(resolve => { complete = resolve; })));
    store.addStop(); store.addStop();
    const [first, second] = store.getSnapshot().stops.slice(1, -1);
    store.updatePlace(first.id, { ...start, label: "Senec" }, "Senec");
    store.updatePlace(second.id, { ...end, label: "Brno" }, "Brno");
    const request = store.calculate();
    store.reorderStop(1, 0);
    expect(store.getSnapshot().stops.map(stop => stop.query)).toEqual(["Praha", "Bratislava", "Senec", "Brno"]);
    expect(store.getSnapshot().stops[2]).toMatchObject({ id: first.id, place: { label: "Senec" } });
    complete(response()); await request;
    expect(store.getSnapshot().result).toBeNull();
    expect(store.getSnapshot().busy).toBe(false);
    const snapshot = store.getSnapshot();
    store.reorderStop(999, 0); store.reorderStop(0, 0);
    expect(store.getSnapshot()).toBe(snapshot);
  });
});
