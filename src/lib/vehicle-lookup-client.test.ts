import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestVehicleLookup } from "./vehicle-lookup-client";

const input = { kind: "plate" as const, value: "XX000XX", country: "SK" as const };
const snapshot = { proof: "a".repeat(43), result: { version: 1, id: "test", query: { ...input, checkedForDate: "2026-09-05" }, fetchedAt: "2026-09-05T08:00:00Z", sources: [] } };
const busy = (retryAfter = "5") => Response.json({ error: "Busy" }, { status: 409, headers: { "Retry-After": retryAfter } });
const request = vi.fn<typeof fetch>();
beforeEach(() => { vi.useFakeTimers(); request.mockReset(); vi.stubGlobal("fetch", request); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("waits for the occupied query, then receives the shared cached result", async () => {
  request.mockResolvedValueOnce(busy()).mockResolvedValueOnce(Response.json({ snapshot, cached: true }));
  const waiting = vi.fn();
  const pending = requestVehicleLookup(input, new AbortController().signal, waiting);
  await vi.advanceTimersByTimeAsync(4999);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ snapshot, cached: true });
  expect(waiting.mock.calls).toEqual([[5], [0]]);
  expect(request.mock.calls[0][1]?.body).toBe(request.mock.calls[1][1]?.body);
});
it("cancels pending retry when the vehicle changes", async () => {
  request.mockResolvedValue(busy());
  const controller = new AbortController();
  const pending = requestVehicleLookup(input, controller.signal, vi.fn());
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(100);
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledTimes(1);
});
it("stops after bounded waiting rather than spinning indefinitely", async () => {
  request.mockImplementation(async () => busy());
  const rejected = expect(requestVehicleLookup(input, new AbortController().signal, vi.fn())).rejects.toThrow("Busy");
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(request).toHaveBeenCalledTimes(7);
});
it.each([429, 503])("does not retry HTTP %s", async status => {
  request.mockResolvedValue(Response.json({ error: "Unavailable" }, { status, headers: { "Retry-After": "5" } }));
  await expect(requestVehicleLookup(input, new AbortController().signal, vi.fn())).rejects.toThrow("Unavailable");
  expect(request).toHaveBeenCalledTimes(1);
});
it("does not shorten a server delay longer than its wait budget", async () => {
  request.mockResolvedValue(busy("60"));
  await expect(requestVehicleLookup(input, new AbortController().signal, vi.fn())).rejects.toThrow("Busy");
  expect(request).toHaveBeenCalledTimes(1);
});
