import { describe, expect, it, vi } from "vitest";

import {
  isAbortLikeError,
  isTelephonyTimeout,
  nextBackoffDelayMs,
  telephonyFetch,
  telephonyJson,
  TELEPHONY_TIMEOUT_MS,
  TelephonyRequestTimeoutError,
} from "./client-request";

describe("bounded telephony requests", () => {
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
    // A caller abort must never be reported as a timeout: only a timeout
    // implies the request may still have reached the provider.
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
