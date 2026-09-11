import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isAbortLikeError,
  isTelephonyTimeout,
  nextBackoffDelayMs,
  telephonyFetch,
  telephonyJson,
  TELEPHONY_TIMEOUT_MS,
  TelephonyRequestTimeoutError,
} from "./client-request";

afterEach(() => vi.useRealTimers());

describe("bounded telephony requests", () => {
  it("aborts and cancels a stalled response body after headers without retrying", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    let requestSignal: AbortSignal | null | undefined;
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); },
        cancel: cancelled,
      }), { status: 200 });
    });
    const pending = telephonyJson("/api/telephony/calls/active", { label: "hovory", timeoutMs: 50 },
      { fetch: fetchSpy as typeof fetch }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBeInstanceOf(TelephonyRequestTimeoutError);
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains caller cancellation during the response body instead of returning malformed JSON", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    let bodyStarted!: () => void;
    const ready = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const fetchSpy = vi.fn(async () => new Response(new ReadableStream({
      pull() { bodyStarted(); }, cancel: cancelled,
    })));
    const pending = telephonyJson("/api/telephony/calls/active", { label: "hovory", timeoutMs: 1000, signal: controller.signal },
      { fetch: fetchSpy as typeof fetch }).catch((error: unknown) => error);
    await ready;
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ name: "AbortError" });
    expect(isTelephonyTimeout(error)).toBe(false);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("bounds API body memory and cancels oversized responses", async () => {
    const cancelled = vi.fn();
    const fetchSpy = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
      cancel: cancelled,
    })));
    await expect(telephonyJson("/api/telephony/calls/active", { label: "hovory", timeoutMs: 1000 },
      { fetch: fetchSpy as typeof fetch })).rejects.toThrow(/príliš veľká/);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("accepts a call-control result after 15 seconds without aborting or retrying", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    const fetchSpy = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const responseTimer = setTimeout(() => resolve(jsonResponse(200, { ok: true, state: "ended" })), 15_000);
      init?.signal?.addEventListener("abort", () => {
        aborted();
        clearTimeout(responseTimer);
        reject(abortError());
      }, { once: true });
    }));
    const pending = telephonyJson(
      "/api/telephony/calls/session/hangup",
      { method: "POST", label: "ukončenie hovoru", timeoutMs: TELEPHONY_TIMEOUT_MS.control },
      { fetch: fetchSpy as unknown as typeof fetch },
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toEqual({ ok: true, status: 200, body: { ok: true, state: "ended" } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(aborted).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("still aborts an unresponsive call-control request at 30 seconds without retrying", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    const fetchSpy = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted(); reject(abortError()); }, { once: true });
    }));
    const pending = telephonyJson(
      "/api/telephony/calls/session/hangup",
      { method: "POST", label: "ukončenie hovoru", timeoutMs: TELEPHONY_TIMEOUT_MS.control },
      { fetch: fetchSpy as unknown as typeof fetch },
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(aborted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(TelephonyRequestTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 30_000, label: "ukončenie hovoru" });
    expect(aborted).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("times out a response that never arrives", async () => {
    // A hung endpoint used to pin the caller forever; the budget must fire
    // even though the promise itself never settles.
    const never = (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });

    const error = await telephonyFetch(
      "/api/telephony/calls/active",
      { label: "aktívne hovory", timeoutMs: 20 },
      { fetch: never as unknown as typeof fetch },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelephonyRequestTimeoutError);
    expect(isTelephonyTimeout(error)).toBe(true);
    expect((error as TelephonyRequestTimeoutError).label).toBe("aktívne hovory");
  });

  it("clears its timer so a completed request cannot fire a late abort", async () => {
    const clearSpy = vi.fn(globalThis.clearTimeout);
    const ok = async () => jsonResponse(200, { ok: true });

    await telephonyFetch(
      "/api/telephony/calls/active",
      { label: "aktívne hovory", timeoutMs: 8_000 },
      { fetch: ok as unknown as typeof fetch, clearTimeout: clearSpy as unknown as typeof clearTimeout },
    );

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("distinguishes our timeout from a caller abort", async () => {
    const controller = new AbortController();
    const abortable = (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });

    const pending = telephonyFetch(
      "/api/telephony/calls/active",
      { label: "aktívne hovory", signal: controller.signal, timeoutMs: 60_000 },
      { fetch: abortable as unknown as typeof fetch },
    );
    controller.abort();

    const error = await pending.catch((caught: unknown) => caught);
    // Caller cancellation stays distinguishable. Neither kind of cancellation
    // proves the remote mutation did not happen.
    expect(isTelephonyTimeout(error)).toBe(false);
    expect(isAbortLikeError(error)).toBe(true);
  });

  it("refuses to start when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchSpy = vi.fn();

    await expect(telephonyFetch(
      "/api/telephony/calls/active",
      { label: "aktívne hovory", signal: controller.signal, timeoutMs: 8_000 },
      { fetch: fetchSpy as unknown as typeof fetch },
    )).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never retries by itself", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(500, { error: "nope" }));

    const result = await telephonyJson<{ error: string }>(
      "/api/telephony/calls/active",
      { label: "aktívne hovory", timeoutMs: 8_000 },
      { fetch: fetchSpy as unknown as typeof fetch },
    );

    // A non-2xx is returned rather than thrown, so callers can surface the
    // server's own Slovak message, and exactly one request was made.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, status: 500, body: { error: "nope" } });
  });

  it("returns a null body instead of throwing on unparsable json", async () => {
    const broken = async () => new Response("not json", { status: 200 });

    await expect(telephonyJson(
      "/api/telephony/calls/active",
      { label: "aktívne hovory", timeoutMs: 8_000 },
      { fetch: broken as unknown as typeof fetch },
    )).resolves.toEqual({ ok: true, status: 200, body: null });
  });

  it("sends no-store and same-origin but lets the caller set method and body", async () => {
    const fetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse(200, { ok: true });
    });

    await telephonyFetch(
      "/api/telephony/workplace-selection",
      { label: "výber pracoviska", method: "PATCH", body: "{}", timeoutMs: TELEPHONY_TIMEOUT_MS.mutation },
      { fetch: fetchSpy as unknown as typeof fetch },
    );

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.method).toBe("PATCH");
    expect(init?.signal).toBeDefined();
  });
});

describe("poll backoff", () => {
  it("returns the base delay while healthy and grows under failure", () => {
    const base = nextBackoffDelayMs({ baseMs: 1_000, consecutiveFailures: 0, maxMs: 30_000, random: () => 0.5 });
    const third = nextBackoffDelayMs({ baseMs: 1_000, consecutiveFailures: 3, maxMs: 30_000, random: () => 0.5 });

    expect(base).toBe(1_000);
    expect(third).toBeGreaterThan(base);
  });

  it("never exceeds the cap or falls below the base, across the jitter range", () => {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      const delay = nextBackoffDelayMs({ baseMs: 1_000, consecutiveFailures: 20, maxMs: 30_000, random });
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  it("spreads retries so every console does not return in the same instant", () => {
    const low = nextBackoffDelayMs({ baseMs: 1_000, consecutiveFailures: 4, maxMs: 30_000, random: () => 0 });
    const high = nextBackoffDelayMs({ baseMs: 1_000, consecutiveFailures: 4, maxMs: 30_000, random: () => 1 });

    expect(high).toBeGreaterThan(low);
  });
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
