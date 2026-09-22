import { describe, expect, it, vi } from "vitest";
import { callControlRetryPolicy, retryUnstartedCallControl } from "./call-control-retry";
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

  it("retries a pickup once on pre-action contention", async () => {
    const policy = callControlRetryPolicy("pickup");
    expect(policy).toEqual({ enabled: true, attempts: 1 });
    const request = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(success);
    const onRetry = vi.fn();
    expect(await retryUnstartedCallControl({ request, ...policy, onRetry, wait: async () => {}, isCurrent: () => true, canRetry: () => true })).toEqual(success);
    expect(request).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls).toEqual([[1]]);
    // A colleague took the call: it left the list, so the click is not replayed.
    request.mockReset().mockResolvedValue(busy);
    expect(await retryUnstartedCallControl({ request, ...policy, wait: async () => {}, isCurrent: () => true, canRetry: () => false })).toEqual(busy);
    expect(request).toHaveBeenCalledOnce();
  });

  it("second hangup retry only with remaining budget", async () => {
    const policy = callControlRetryPolicy("hangup");
    expect(policy).toMatchObject({ enabled: true, attempts: 2 });
    const run = async (perRequestMs: number, answers: Array<typeof busy | typeof success> = []) => {
      let clock = 0;
      const request = vi.fn(async () => { clock += perRequestMs; return answers.shift() ?? busy; });
      const onRetry = vi.fn();
      const result = await retryUnstartedCallControl({ request, ...policy, onRetry, budgetMs: 30_000, now: () => clock, wait: async () => {}, isCurrent: () => true });
      return { result, calls: request.mock.calls.length, retries: onRetry.mock.calls };
    };
    // 18 s elapsed after the second answer: 12 s remain, more than the 10 s floor.
    expect(await run(9_000)).toEqual({ result: busy, calls: 3, retries: [[1], [2]] });
    // 22 s elapsed: 8 s remain, so the ordinary 409 confirmation path takes over.
    expect(await run(11_000)).toEqual({ result: busy, calls: 2, retries: [[1]] });
    // A success on the second replay is returned.
    expect(await run(9_000, [busy, busy, success])).toEqual({ result: success, calls: 3, retries: [[1], [2]] });
  });
});


it("suppresses a stale first generic failure but retains a current error when retry eligibility is false", async () => {
  const response = { ok: false, status: 503, body: { code: "session_event_deferred" } };
  const request = vi.fn().mockResolvedValue(response);
  expect(await retryUnstartedCallControl({ request, enabled: true, isCurrent: () => false })).toBeNull();
  expect(await retryUnstartedCallControl({ request, enabled: true, isCurrent: () => true, canRetry: () => false })).toEqual(response);
  expect(request).toHaveBeenCalledTimes(2);
});
