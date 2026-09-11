import { afterEach, describe, expect, it, vi } from "vitest";

import { beginBrowserCallStep } from "./call-timing";

afterEach(() => vi.restoreAllMocks());

describe("local call timing", () => {
  it("joins delayed exact-leg correlation to the operation and its HTTP request without raw provider IDs", () => {
    const measure = vi.spyOn(performance, "measure");
    const context = { operationId: "pending" };
    const finish = beginBrowserCallStep("invite_to_active", context);
    context.operationId = "00000000-0000-4000-8000-000000000123";
    finish({ requestId: "00000000-0000-4000-8000-000000000456" });
    expect(measure).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ detail: {
      phase: "invite_to_active", outcome: "ok", operationId: context.operationId, requestId: "00000000-0000-4000-8000-000000000456",
    } }));
  });
  it("records one completed phase without arbitrary identifiers", () => {
    const measure = vi.spyOn(performance, "measure");
    const finish = beginBrowserCallStep("request");
    finish({ requestId: "private-call-control-id" });
    finish({ outcome: "failed" });
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith(expect.stringMatching(/^motorist\.call\.request\./), {
      start: expect.any(Number), end: expect.any(Number), detail: { phase: "request", outcome: "ok" },
    });
  });

  it("bounds retained measurements and tolerates unavailable User Timing", () => {
    const clear = vi.spyOn(performance, "clearMeasures");
    for (let index = 0; index < 205; index += 1) beginBrowserCallStep("answer")();
    expect(clear.mock.calls.length).toBeGreaterThanOrEqual(5);
    const measure = vi.spyOn(performance, "measure").mockImplementation(() => { throw new Error("unsupported"); });
    expect(() => beginBrowserCallStep("audio_playback")()).not.toThrow();
    expect(measure).toHaveBeenCalledTimes(1);
  });
});
