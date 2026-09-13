import { describe, expect, it, vi } from "vitest";
import { retryUnstartedCallControl } from "./call-control-retry";
const busy = { ok: false, status: 503, body: { code: "session_busy", retryAfterMs: 1000 } };
const success = { ok: true, status: 200, body: {} };

describe("retryUnstartedCallControl", () => {
  it("retries exactly once after a proven pre-action contention and returns accepted result", async () => {
    const request = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(success);
    const wait = vi.fn(async () => {});
    expect(await retryUnstartedCallControl({ request, wait, enabled: true, isCurrent: () => true })).toEqual(success);
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1000);
  });
  it("returns repeated contention without a third action request", async () => {
    const request = vi.fn().mockResolvedValue(busy);
    expect(await retryUnstartedCallControl({ request, enabled: true, isCurrent: () => true, wait: async () => {} })).toEqual(busy);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([500, 502, 503])("does not replay a generic HTTP%s error", async (status) => {
    const response = { ok: false, status, body: { code: "session_event_deferred" } };
    const request = vi.fn().mockResolvedValue(response);
    await retryUnstartedCallControl({ request, enabled: true, isCurrent: () => true });
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not replay a timeout or call-start operation", async () => {
    const request = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(retryUnstartedCallControl({ request, enabled: true, isCurrent: () => true })).rejects.toThrow("timeout");
    expect(request).toHaveBeenCalledOnce();
    request.mockReset().mockResolvedValue(busy);
    expect(await retryUnstartedCallControl({ request, enabled: false, isCurrent: () => true })).toEqual(busy);
    expect(request).toHaveBeenCalledOnce();
  });
  it("cancels the waiting retry when hangup or another call supersedes its owner", async () => {
    let current = true;
    const request = vi.fn().mockResolvedValue(busy);
    expect(await retryUnstartedCallControl({ request, enabled: true, isCurrent: () => current, wait: async () => { current = false; } })).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });
  it("bounds a server-suggested delay and ignores a stale second reply", async () => {
    let current = true;
    const wait = vi.fn(async () => {});
    const request = vi.fn().mockResolvedValueOnce({ ...busy, body: { ...busy.body, retryAfterMs: 99_999 } })
      .mockImplementationOnce(async () => { current = false; return success; });
    expect(await retryUnstartedCallControl({ request, enabled: true, isCurrent: () => current, wait })).toBeNull();
    expect(wait).toHaveBeenCalledWith(1500);
    expect(request).toHaveBeenCalledTimes(2);
  });
});


it("suppresses a stale first generic failure but retains a current error when retry eligibility is false", async () => {
  const response = { ok: false, status: 503, body: { code: "session_event_deferred" } };
  const request = vi.fn().mockResolvedValue(response);
  expect(await retryUnstartedCallControl({ request, enabled: true, isCurrent: () => false })).toBeNull();
  expect(await retryUnstartedCallControl({ request, enabled: true, isCurrent: () => true, canRetry: () => false })).toEqual(response);
  expect(request).toHaveBeenCalledTimes(2);
});
