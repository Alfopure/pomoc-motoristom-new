import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ToolRequest } from "./request";

export function useToolRequest<T>(active: boolean) {
  const request = useMemo(() => new ToolRequest<T>(), []);
  const state = useSyncExternalStore(request.subscribe, request.snapshot, request.snapshot);
  const [, tick] = useState(0);
  useLayoutEffect(() => { request.setActive(active); }, [request, active]);
  useEffect(() => () => request.dispose(), [request]);
  useEffect(() => {
    if (!active || !state.retryAt || !request.remainingSeconds()) return;
    const timer = setInterval(() => { tick(value => value + 1); if (!request.remainingSeconds()) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [active, state.retryAt, request]);
  return { request, ...state, remaining: request.remainingSeconds() };
}
