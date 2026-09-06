import { describe, expect, it, vi } from "vitest";

import { acquireCallWakeLock } from "./call-wake-lock";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sentinel() {
  const lock = {
    released: false,
    release: vi.fn(async () => {
      lock.released = true;
    }),
  };
  return lock as typeof lock & WakeLockSentinel;
}

function browser(initialVisibility: DocumentVisibilityState = "visible") {
  const document = Object.assign(new EventTarget(), { visibilityState: initialVisibility });
  const request = vi.fn<(type: "screen") => Promise<WakeLockSentinel>>();
  return {
    document,
    navigator: { wakeLock: { request } },
    request,
    setVisibility(visibility: DocumentVisibilityState) {
      document.visibilityState = visibility;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

async function settle() {
  // Request and release each introduce a microtask, including stale requests.
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("acquireCallWakeLock", () => {
  it("is harmless without browser support or a document", () => {
    expect(() => acquireCallWakeLock({})()).not.toThrow();
    const page = browser();
    const addListener = vi.spyOn(page.document, "addEventListener");
    acquireCallWakeLock({ document: page.document, navigator: {} })();
    expect(addListener).not.toHaveBeenCalled();
  });

  it("requests a visible call once and releases it once when the call ends", async () => {
    const page = browser();
    const lock = sentinel();
    page.request.mockResolvedValue(lock);
    const stop = acquireCallWakeLock(page);
    await settle();
    page.setVisibility("visible");
    expect(page.request).toHaveBeenCalledExactlyOnceWith("screen");
    stop();
    stop();
    await settle();
    page.setVisibility("visible");
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(page.request).toHaveBeenCalledTimes(1);
  });

  it("waits for a hidden call to become visible, releases when hidden, and reacquires on return", async () => {
    const page = browser("hidden");
    const first = sentinel();
    const second = sentinel();
    page.request.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const stop = acquireCallWakeLock(page);
    expect(page.request).not.toHaveBeenCalled();
    page.setVisibility("visible");
    await settle();
    page.setVisibility("hidden");
    await settle();
    expect(first.release).toHaveBeenCalledTimes(1);
    page.setVisibility("visible");
    await settle();
    expect(page.request).toHaveBeenCalledTimes(2);
    stop();
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  it("releases a request that resolves after the call has ended", async () => {
    const page = browser();
    const pending = deferred<WakeLockSentinel>();
    const lock = sentinel();
    page.request.mockReturnValue(pending.promise);
    const stop = acquireCallWakeLock(page);
    stop();
    pending.resolve(lock);
    await settle();
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(page.request).toHaveBeenCalledTimes(1);
  });

  it("releases a request that resolves while hidden without requesting another lock", async () => {
    const page = browser();
    const pending = deferred<WakeLockSentinel>();
    const lock = sentinel();
    page.request.mockReturnValue(pending.promise);
    const stop = acquireCallWakeLock(page);
    page.setVisibility("hidden");
    pending.resolve(lock);
    await settle();
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(page.request).toHaveBeenCalledTimes(1);
    stop();
  });

  it("serializes hide/show races, releasing the stale request before reacquiring", async () => {
    const page = browser();
    const pending = deferred<WakeLockSentinel>();
    const releasing = deferred<void>();
    const stale = sentinel();
    stale.release.mockReturnValue(releasing.promise);
    const current = sentinel();
    page.request.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(current);
    const stop = acquireCallWakeLock(page);
    page.setVisibility("visible");
    page.setVisibility("hidden");
    page.setVisibility("visible");
    expect(page.request).toHaveBeenCalledTimes(1);
    pending.resolve(stale);
    await settle();
    expect(stale.release).toHaveBeenCalledTimes(1);
    page.setVisibility("visible");
    expect(page.request).toHaveBeenCalledTimes(1);
    releasing.resolve();
    await settle();
    expect(page.request).toHaveBeenCalledTimes(2);
    stop();
    expect(current.release).toHaveBeenCalledTimes(1);
  });

  it("does not loop on a refusal but may retry after returning to the call", async () => {
    const page = browser();
    const lock = sentinel();
    page.request.mockRejectedValueOnce(new Error("NotAllowedError")).mockResolvedValueOnce(lock);
    const stop = acquireCallWakeLock(page);
    await settle();
    expect(page.request).toHaveBeenCalledTimes(1);
    page.setVisibility("hidden");
    page.setVisibility("visible");
    await settle();
    expect(page.request).toHaveBeenCalledTimes(2);
    stop();
  });

  it("retries after a pending refusal belongs to an earlier visibility period", async () => {
    const page = browser();
    const pending = deferred<WakeLockSentinel>();
    const lock = sentinel();
    page.request.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(lock);
    const stop = acquireCallWakeLock(page);
    page.setVisibility("hidden");
    page.setVisibility("visible");
    pending.reject(new Error("NotAllowedError"));
    await settle();
    expect(page.request).toHaveBeenCalledTimes(2);
    stop();
  });

  it("handles browser release and release failures without affecting call cleanup", async () => {
    const page = browser();
    const first = sentinel();
    const second = sentinel();
    second.release.mockRejectedValue(new Error("Already released"));
    page.request.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const stop = acquireCallWakeLock(page);
    await settle();
    first.released = true;
    page.setVisibility("visible");
    await settle();
    expect(page.request).toHaveBeenCalledTimes(2);
    expect(() => stop()).not.toThrow();
    await settle();
    expect(second.release).toHaveBeenCalledTimes(1);
  });
});
