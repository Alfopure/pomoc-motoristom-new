import { describe, expect, it } from "vitest";

import type { CommanderResponse } from "./client";
import { rateLimitBackoffMs, requestWithRateLimitRetry } from "./sync";

function makeResponse(overrides: Partial<CommanderResponse<unknown>> & { retryAfterSeconds?: number | null } = {}): CommanderResponse<unknown> {
  const { retryAfterSeconds = null, ...rest } = overrides;
  return {
    endpoint: "positions",
    path: "/last-positions?page=1",
    status: 200,
    ok: true,
    data: null,
    error: null,
    rateLimit: { limit: null, remaining: null, reset: null, retryAfterSeconds },
    headersSafe: {},
    ...rest,
  };
}

describe("rateLimitBackoffMs — Commander ctí retry-after (T1)", () => {
  it("bez rate-limitu → žiadny backoff", () => {
    expect(rateLimitBackoffMs(makeResponse())).toBe(0);
  });

  it("429 bez retry-after → default 1s odklad", () => {
    expect(rateLimitBackoffMs(makeResponse({ status: 429, ok: false }))).toBe(1000);
  });

  it("retry-after sa reálne odloží (5s → 5000ms) aj pri 200", () => {
    expect(rateLimitBackoffMs(makeResponse({ retryAfterSeconds: 5 }))).toBe(5000);
  });

  it("429 s retry-after 12s → 12000ms", () => {
    expect(rateLimitBackoffMs(makeResponse({ status: 429, ok: false, retryAfterSeconds: 12 }))).toBe(12000);
  });

  it("neúmerný retry-after je capnutý stropom", () => {
    expect(rateLimitBackoffMs(makeResponse({ retryAfterSeconds: 100 }), 30)).toBe(30_000);
  });
});

describe("requestWithRateLimitRetry — Commander zopakuje rovnakú stránku po 429", () => {
  it("počká podľa retry-after a potom vráti úspešný pokus", async () => {
    const queue = [
      makeResponse({ status: 429, ok: false, retryAfterSeconds: 3 }),
      makeResponse({ status: 200, ok: true }),
    ];
    const waits: number[] = [];
    const responses = await requestWithRateLimitRetry(async () => queue.shift()!, {
      sleepFn: async (ms) => {
        waits.push(ms);
      },
    });

    expect(responses.map((response) => response.status)).toEqual([429, 200]);
    expect(waits).toEqual([3000]);
  });

  it("po dosiahnutí limitu retry skončí poslednou 429", async () => {
    const request = async () => makeResponse({ status: 429, ok: false, retryAfterSeconds: 1 });
    const responses = await requestWithRateLimitRetry(request, { maxRetries: 2, sleepFn: async () => undefined });

    expect(responses).toHaveLength(3);
    expect(responses.every((response) => response.status === 429)).toBe(true);
  });

  it("inú chybu bez rate-limitu neopakuje", async () => {
    let calls = 0;
    const responses = await requestWithRateLimitRetry(async () => {
      calls += 1;
      return makeResponse({ status: 503, ok: false });
    });

    expect(calls).toBe(1);
    expect(responses).toHaveLength(1);
  });
});
