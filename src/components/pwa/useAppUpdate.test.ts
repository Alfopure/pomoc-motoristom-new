import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchAppUpdates } from "./useAppUpdate";

type HealthResponse = Pick<Response, "ok" | "json">;

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.useRealTimers();
});

function health(version: unknown, status = "live"): HealthResponse {
  return { ok: true, json: async () => ({ status, version }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: { version?: string; hidden?: boolean; offline?: boolean } = {}) {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    visibilityState: (options.hidden ? "hidden" : "visible") as DocumentVisibilityState,
  });
  const connection = { online: !options.offline };
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<HealthResponse>>()
    .mockResolvedValue(health("release-a"));
  const onChange = vi.fn<(available: boolean) => void>();
  const start = () => {
    const stop = watchAppUpdates(options.version ?? "release-a", onChange, {
      window, document, fetch, isOnline: () => connection.online,
    });
    cleanups.push(stop);
    return stop;
  };
  const emit = (event: string) => {
    (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event));
  };
  return { window, document, connection, fetch, onChange, start, emit };
}

describe("application release discovery", () => {
  it("checks on mount without caching or following redirects away from this app", async () => {
    const app = fixture();
    app.fetch.mockResolvedValue(health("release-b"));
    app.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(app.fetch).toHaveBeenCalledExactlyOnceWith("/api/health/live", {
      method: "GET", cache: "no-store", credentials: "same-origin",
      mode: "same-origin", redirect: "error", signal: expect.any(AbortSignal),
    });
    expect(app.onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("always compares with the loaded document, including rollback to its original release", async () => {
    const app = fixture({ version: "release-20" });
    app.fetch.mockResolvedValueOnce(health("release-19"))
      .mockResolvedValueOnce(health("release-21"))
      .mockResolvedValueOnce(health("release-20"));
    app.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    app.emit("focus");
    await vi.advanceTimersByTimeAsync(15_000);
    app.emit("pageshow");
    await vi.advanceTimersByTimeAsync(0);

    expect(app.onChange.mock.calls).toEqual([[true], [true], [false]]);
  });

  it.each(["", "development", " Development ", "local", "unknown", "undefined", "release/invalid"])(
    "does not poll with an unknown loaded version (%s)", async (version) => {
      const app = fixture({ version });
      app.start();
      app.emit("online");
      await vi.advanceTimersByTimeAsync(300_000);
      expect(app.fetch).not.toHaveBeenCalled();
      expect(app.onChange).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    health("development"), health(null), health(42), health("release-b", "starting"),
    { ok: true, json: async () => null },
    { ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } },
    { ok: false, json: async () => ({ status: "live", version: "release-b" }) },
  ])("ignores invalid responses without losing a previously detected update", async (response) => {
    const app = fixture();
    app.fetch.mockResolvedValueOnce(health("release-b")).mockResolvedValueOnce(response);
    app.start();
    await vi.advanceTimersByTimeAsync(15_000);
    app.emit("focus");
    await vi.advanceTimersByTimeAsync(0);

    expect(app.fetch).toHaveBeenCalledTimes(2);
    expect(app.onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("coalesces visibility, focus, pageshow and online bursts for fifteen seconds", async () => {
    const app = fixture();
    app.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const event of ["visibilitychange", "focus", "pageshow", "online"]) app.emit(event);
    await vi.advanceTimersByTimeAsync(14_999);
    app.emit("focus");
    expect(app.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    app.emit("pageshow");
    app.emit("focus");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.fetch).toHaveBeenCalledTimes(2);
  });

  it("polls visible documents every five minutes and checks immediately when a hidden document returns", async () => {
    const app = fixture({ hidden: true });
    app.start();
    app.emit("focus");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(app.fetch).not.toHaveBeenCalled();
    app.document.visibilityState = "visible";
    app.emit("visibilitychange");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(app.fetch).toHaveBeenCalledTimes(2);
    app.document.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(300_000);
    expect(app.fetch).toHaveBeenCalledTimes(2);
    app.document.visibilityState = "visible";
    app.emit("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.fetch).toHaveBeenCalledTimes(3);
  });

  it("skips offline checks and lets restored connectivity bypass a recent successful check", async () => {
    const app = fixture({ offline: true });
    app.start();
    await vi.advanceTimersByTimeAsync(300_000);
    app.emit("focus");
    expect(app.fetch).not.toHaveBeenCalled();
    app.connection.online = true;
    app.emit("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.fetch).toHaveBeenCalledOnce();

    app.connection.online = false;
    app.emit("offline");
    app.document.visibilityState = "hidden";
    app.connection.online = true;
    app.emit("online");
    expect(app.fetch).toHaveBeenCalledOnce();
    app.document.visibilityState = "visible";
    app.emit("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries promptly on online after failure but still throttles ordinary focus events", async () => {
    const app = fixture();
    app.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    app.start();
    await vi.advanceTimersByTimeAsync(0);
    app.emit("focus");
    expect(app.fetch).toHaveBeenCalledOnce();
    app.emit("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.fetch).toHaveBeenCalledTimes(2);
    expect(app.onChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("waits for an in-flight request before retrying an online recovery", async () => {
    const app = fixture();
    const first = deferred<HealthResponse>();
    app.fetch.mockReturnValueOnce(first.promise);
    app.start();
    await vi.advanceTimersByTimeAsync(5_000);
    for (const event of ["focus", "pageshow", "offline", "online"]) app.emit(event);
    expect(app.fetch).toHaveBeenCalledOnce();
    first.reject(new TypeError("connection lost"));
    await vi.advanceTimersByTimeAsync(0);
    expect(app.fetch).toHaveBeenCalledTimes(2);
    expect(app.onChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("aborts a timed-out request, permits another check and ignores its late response", async () => {
    const app = fixture();
    const first = deferred<HealthResponse>();
    app.fetch.mockReturnValueOnce(first.promise);
    app.start();
    const signal = app.fetch.mock.calls[0]![1].signal!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(true);
    app.emit("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.fetch).toHaveBeenCalledTimes(2);
    first.resolve(health("release-b"));
    await vi.advanceTimersByTimeAsync(0);
    expect(app.onChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("removes listeners and timers and aborts pending work when the caller unmounts", async () => {
    const app = fixture();
    const first = deferred<HealthResponse>();
    app.fetch.mockReturnValueOnce(first.promise);
    const stop = app.start();
    const signal = app.fetch.mock.calls[0]![1].signal!;
    stop();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    for (const event of ["visibilitychange", "focus", "pageshow", "offline", "online"]) app.emit(event);
    first.resolve(health("release-b"));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(app.fetch).toHaveBeenCalledOnce();
    expect(app.onChange).not.toHaveBeenCalled();
  });
});
