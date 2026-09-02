import { afterEach, describe, expect, it, vi } from "vitest";

import { interruptibleDelay } from "./interruptible-delay";

afterEach(() => vi.useRealTimers());

describe("interruptibleDelay", () => {
  it("ends a maximum provider backoff immediately on shutdown", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let completed = false;
    const waiting = interruptibleDelay(75_000, controller.signal).then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(completed).toBe(false);
    controller.abort();
    await waiting;
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
