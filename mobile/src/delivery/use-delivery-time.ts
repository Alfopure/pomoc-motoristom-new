import { useLayoutEffect, useState } from "react";

/** Expiration also advances when the server is unreachable. No background timer. */
export function useDeliveryTime(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useLayoutEffect(() => {
    if (!active) return;
    // Refresh before painting customer data on return from suspension.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
