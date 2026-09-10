import { isDrivingRouteResult, MAX_ROUTE_INTERMEDIATES, type DrivingRouteResult } from "@/lib/driving-route";

export type RoutePlace = { lat: number; lng: number; label: string };
export type RouteStop = { id: number; query: string; place: RoutePlace | null };
export type RoutePlannerSnapshot = { stops: RouteStop[]; result: DrivingRouteResult | null; busy: boolean; error: string | null };

/** One in-memory route draft for map and widget. No lookup is started by subscription. */
export function createRoutePlannerStore(fetchRoute: typeof fetch = (...args) => fetch(...args)) {
  let state: RoutePlannerSnapshot = { stops: [{ id: 0, query: "", place: null }, { id: 1, query: "", place: null }], result: null, busy: false, error: null };
  let nextId = 2;
  let request: AbortController | null = null;
  const listeners = new Set<() => void>();
  function publish(next: RoutePlannerSnapshot) { state = next; listeners.forEach(listener => listener()); }
  function updateStops(stops: RouteStop[]) {
    request?.abort();
    request = null;
    publish({ stops, result: null, busy: false, error: null });
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    updatePlace: (id: number, place: RoutePlace | null, query: string) => updateStops(state.stops.map(stop => stop.id === id ? { ...stop, place, query } : stop)),
    addStop: () => { if (state.stops.length < MAX_ROUTE_INTERMEDIATES + 2) updateStops([...state.stops.slice(0, -1), { id: nextId++, query: "", place: null }, state.stops[state.stops.length - 1]]); },
    removeStop: (id: number) => { if (state.stops.slice(1, -1).some(stop => stop.id === id)) updateStops(state.stops.filter(stop => stop.id !== id)); },
    reverse: () => updateStops([...state.stops].reverse()),
    moveStop: (index: number, offset: number) => {
      const destination = index + offset;
      if (index < 1 || index >= state.stops.length - 1 || destination < 1 || destination >= state.stops.length - 1) return;
      const next = [...state.stops];
      [next[index], next[destination]] = [next[destination], next[index]];
      updateStops(next);
    },
    cancel: () => { request?.abort(); request = null; if (state.busy) publish({ ...state, busy: false }); },
    calculate: async () => {
      if (state.stops.some(stop => !stop.place)) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const points = state.stops.map(stop => ({ lat: stop.place!.lat, lng: stop.place!.lng }));
      publish({ ...state, result: null, busy: true, error: null });
      try {
        const response = await fetchRoute("/api/maps/route", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ origin: points[0], destination: points.at(-1), intermediates: points.slice(1, -1) }),
        });
        const data: unknown = await response.json();
        if (!response.ok || !isDrivingRouteResult(data)) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Trasu sa nepodarilo vypočítať. Skúste to znova.");
        if (!controller.signal.aborted) publish({ ...state, result: data, busy: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted) publish({ ...state, busy: false, error: error instanceof Error ? error.message : "Výpočet trasy zlyhal. Skúste to znova." });
      }
    },
  };
}
export type RoutePlannerStore = ReturnType<typeof createRoutePlannerStore>;
