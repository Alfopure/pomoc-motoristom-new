import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

/** Native events invalidate immediately, including a background/active pair
 * delivered before React commits either intermediate active prop. */
export function useForegroundVisit(active: boolean, onInvalidate?: () => void) {
  const [revision, setRevision] = useState(0);
  const activity = useRef(AppState.currentState ?? "active");
  const invalidate = useRef(onInvalidate);
  const token = useMemo(() => ({ active, revision }), [active, revision]);
  const live = useRef<object | null>(null);
  useLayoutEffect(() => { invalidate.current = onInvalidate; }, [onInvalidate]);
  useLayoutEffect(() => {
    live.current = active && activity.current === "active" ? token : null;
    return () => { if (live.current === token) live.current = null; };
  }, [active, token]);
  useLayoutEffect(() => {
    const subscription = AppState.addEventListener("change", value => {
      activity.current = value;
      live.current = null;
      invalidate.current?.();
      setRevision(value => value + 1);
    });
    return () => { live.current = null; subscription.remove(); };
  }, []);
  return useMemo(() => ({ revision, current: () => live.current === token }), [revision, token]);
}
