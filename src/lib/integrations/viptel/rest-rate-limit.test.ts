import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  acquireViptelRestSlot,
  VIPTEL_REST_MAX_PER_WINDOW,
  VIPTEL_REST_WINDOW_MS,
} from "./client";

/**
 * VIPTel REST allows 20 requests per rolling 5 seconds per IP and blocks the
 * IP for 30 minutes when exceeded (REST API v26.3.2). The limiter must keep
 * the process under that with headroom, because one ban takes the whole
 * dispatch centre's telephony down for half an hour.
 */
describe("VIPTel REST rate limiter", () => {
  function fakeClock(startAt = 1_000_000) {
    let at = startAt;
    const sleeps: number[] = [];
    return {
      now: () => at,
      sleep: async (ms: number) => { sleeps.push(ms); at += ms; },
      advance: (ms: number) => { at += ms; },
      sleeps,
    };
  }

  it("stays under the documented window with margin to spare", () => {
    expect(VIPTEL_REST_MAX_PER_WINDOW).toBeLessThanOrEqual(15);
    expect(VIPTEL_REST_WINDOW_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("lets a full window through without waiting", async () => {
    const clock = fakeClock();
    for (let i = 0; i < VIPTEL_REST_MAX_PER_WINDOW; i += 1) {
      expect(await acquireViptelRestSlot("burst.test", clock.now, clock.sleep)).toBe(0);
    }
    expect(clock.sleeps).toEqual([]);
  });

  it("delays the request over budget until the window slides", async () => {
    const clock = fakeClock();
    for (let i = 0; i < VIPTEL_REST_MAX_PER_WINDOW; i += 1) {
      await acquireViptelRestSlot("over.test", clock.now, clock.sleep);
      clock.advance(10);
    }
    const waited = await acquireViptelRestSlot("over.test", clock.now, clock.sleep);
    expect(waited).toBeGreaterThan(0);
    // It waited roughly until the oldest request left the 5s window, not the
    // whole window over again.
    expect(waited).toBeLessThanOrEqual(VIPTEL_REST_WINDOW_MS);
  });

  it("does not wait once the window has naturally slid past", async () => {
    const clock = fakeClock();
    for (let i = 0; i < VIPTEL_REST_MAX_PER_WINDOW; i += 1) {
      await acquireViptelRestSlot("slide.test", clock.now, clock.sleep);
    }
    clock.advance(VIPTEL_REST_WINDOW_MS + 50);
    expect(await acquireViptelRestSlot("slide.test", clock.now, clock.sleep)).toBe(0);
  });

  it("tracks each host separately", async () => {
    const clock = fakeClock();
    for (let i = 0; i < VIPTEL_REST_MAX_PER_WINDOW; i += 1) {
      await acquireViptelRestSlot("first.host", clock.now, clock.sleep);
    }
    expect(await acquireViptelRestSlot("second.host", clock.now, clock.sleep)).toBe(0);
  });
});
