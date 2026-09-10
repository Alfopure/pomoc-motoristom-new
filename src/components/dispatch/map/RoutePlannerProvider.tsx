"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoutePlannerStore, type RoutePlannerStore } from "./route-planner-model";

const RoutePlannerContext = createContext<RoutePlannerStore | null>(null);

export function RoutePlannerProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createRoutePlannerStore);
  useEffect(() => () => store.cancel(), [store]);
  return <RoutePlannerContext.Provider value={store}>{children}</RoutePlannerContext.Provider>;
}

export function useOptionalRoutePlannerStore() { return useContext(RoutePlannerContext); }
export function useRoutePlanner(store: RoutePlannerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
