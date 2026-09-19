import { afterEach, expect, it, vi } from "vitest";
import { AuthorizationLease } from "./authorization-lease";
afterEach(() => vi.useRealTimers());
it("expires without a network response and uses the request start as conservative authorization time", () => {
  vi.useFakeTimers(); vi.setSystemTime(0); const hide = vi.fn(); const lease = new AuthorizationLease(hide, 30_000);
  vi.setSystemTime(12_000); expect(lease.renew(0)).toBe(true);
  vi.advanceTimersByTime(18_000); expect(hide).toHaveBeenCalledOnce();
  expect(lease.renew(-1000)).toBe(false); lease.clear();
});
