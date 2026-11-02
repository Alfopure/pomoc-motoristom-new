import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLatencyFlags } from "./latency-flags";

const mocks = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));

import { respondWhenDialled } from "./early-start";

afterEach(() => { vi.restoreAllMocks(); mocks.after.mockReset(); });

const on = (logger = vi.fn()) => ({ latencyFlags: { ...defaultLatencyFlags(), start_early_response: true }, logger });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe("respondWhenDialled (call-speed S2.3)", () => {
  it("calls the start exactly as before while the switch is off", async () => {
    const start = vi.fn(async (...early: unknown[]) => ({ early: early.length }));
    await expect(respondWhenDialled({ latencyFlags: defaultLatencyFlags() }, start)).resolves.toEqual({ early: 0 });
    expect(start).toHaveBeenCalledWith();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("answers with the hooked result and keeps the rest of the work for after the response", async () => {
    const rest = deferred<string>();
    const logger = vi.fn();
    const answered = await respondWhenDialled<string>(on(logger), (...early) => { early[0]?.("dialled"); return rest.promise; });
    expect(answered).toBe("dialled");
    expect(mocks.after).toHaveBeenCalledTimes(1);
    const tail = (mocks.after.mock.calls[0][0] as () => Promise<void>)();
    let finished = false;
    void tail.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    rest.reject(new Error("checkpoint unavailable"));
    await tail;
    // A failure behind a sent response is logged, never thrown into the route.
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ code: "start_tail_failed", error: "checkpoint unavailable" }));
  });

  it("waits for the whole work, and its error, when no early result came", async () => {
    await expect(respondWhenDialled(on(), async () => { throw new Error("operator_busy"); })).rejects.toThrow("operator_busy");
    await expect(respondWhenDialled(on(), async () => "full")).resolves.toBe("full");
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("answers once even if the hook fires again, and still settles the tail without a request lifecycle", async () => {
    mocks.after.mockImplementation(() => { throw new Error("`after` was called outside a request scope"); });
    const rest = deferred<string>();
    const answered = await respondWhenDialled<string>(on(), (...early) => { early[0]?.("first"); early[0]?.("second"); return rest.promise; });
    expect(answered).toBe("first");
    rest.resolve("done");
    await rest.promise;
  });
});
