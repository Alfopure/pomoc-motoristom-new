import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthReadRetry, HEALTH_READ_RETRY_MS } from "./health-read";

type Result = { data: number[] | null; error: { message: string; code: string } | null };
const timeout: Result = { data: null, error: { message: "AbortError: un-owned read exceeded 10000 ms", code: "" } };
const success: Result = { data: [1], error: null };
const request = (result: Result) => Promise.resolve(result);

afterEach(() => vi.useRealTimers());

describe("bounded monitoring read verification", () => {
  it("uses a fresh read to verify one timeout without changing a successful result", async () => {
    const retry = request(success);
    const query = vi.fn().mockReturnValueOnce(request(timeout)).mockReturnValueOnce(retry);
    expect(await createHealthReadRetry()(query)).toEqual(success);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(2, expect.any(AbortSignal));
  });

  it("keeps a persistent timeout observable and shares one allowance across checks", async () => {
    const read = createHealthReadRetry();
    const first = vi.fn(() => request(timeout));
    const second = vi.fn(() => request(timeout));
    expect(await read(first)).toEqual(timeout);
    expect(await read(second)).toEqual(timeout);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not multiply retries for checks that fail concurrently", async () => {
    const read = createHealthReadRetry();
    const query = vi.fn(() => request(timeout));
    const results = await Promise.all([read(query), read(query), read(query)]);
    expect(results).toEqual([timeout, timeout, timeout]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it.each([
    { message: "permission denied", code: "42501" },
    { message: timeout.error!.message, code: "42501" },
    { message: "schema cache unavailable", code: "PGRST205" },
    { message: "AbortError: This operation was aborted", code: "" },
    { message: "AbortError: owned database request exceeded 4000 ms", code: "" },
  ])("does not retry permanent failures or caller cancellation: $message ($code)", async error => {
    const result = { data: null, error };
    const query = vi.fn(() => request(result));
    expect(await createHealthReadRetry()(query)).toEqual(result);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("recognizes the fetch transport failure returned by PostgREST", async () => {
    const query = vi.fn().mockReturnValueOnce(request({ data: null, error: { message: "TypeError: fetch failed", code: "" } }))
      .mockReturnValueOnce(request(success));
    expect(await createHealthReadRetry()(query)).toEqual(success);
  });

  it("aborts verification at one second without continuing another attempt", async () => {
    vi.useFakeTimers();
    let retrySignal: AbortSignal | undefined;
    const retry = (signal: AbortSignal) => {
      retrySignal = signal;
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({
        data: null, error: { message: `${signal.reason.name}: ${signal.reason.message}`, code: "" },
      }), { once: true }));
    };
    const query = vi.fn().mockReturnValueOnce(request(timeout)).mockImplementationOnce(retry);
    const pending = createHealthReadRetry()(query);
    await vi.advanceTimersByTimeAsync(HEALTH_READ_RETRY_MS - 1);
    expect(retrySignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ data: null, error: { message: expect.stringContaining("AbortError:") } });
    expect(retrySignal?.aborted).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
