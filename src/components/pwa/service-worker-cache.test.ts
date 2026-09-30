import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");
const origin = "https://dispatch-copy.example";
const assetUrl = `${origin}/_next/static/chunks/dispatch.js`;

function workerFixture() {
  const handlers: Record<string, (event: Record<string, unknown>) => void> = {};
  const put = vi.fn<(request: Request, response: Response) => Promise<void>>().mockResolvedValue(undefined);
  const addAll = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(undefined);
  const cache = { put, addAll };
  const match = vi.fn<(request: Request | string) => Promise<Response | undefined>>().mockResolvedValue(undefined);
  const open = vi.fn<(name: string) => Promise<typeof cache>>().mockResolvedValue(cache);
  const keys = vi.fn<() => Promise<string[]>>().mockResolvedValue(["pm-dispatch-shell-old"]);
  const deleteCache = vi.fn<(name: string) => Promise<boolean>>().mockResolvedValue(true);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("network asset"));
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const claim = vi.fn().mockResolvedValue(undefined);

  vm.runInContext(source, vm.createContext({
    URL,
    Response,
    fetch,
    caches: { match, open, keys, delete: deleteCache },
    self: {
      location: { origin },
      addEventListener: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; },
      skipWaiting,
      clients: { claim },
    },
  }));

  function dispatch(name: string, event: Record<string, unknown> = {}) {
    const lifetimes: Promise<unknown>[] = [];
    const respondWith = vi.fn<(response: Response | Promise<Response>) => void>();
    handlers[name]!({
      ...event,
      respondWith,
      waitUntil: (promise: Promise<unknown>) => { lifetimes.push(promise); },
    });
    return {
      respondWith,
      response: respondWith.mock.calls[0]?.[0],
      complete: () => Promise.all(lifetimes),
    };
  }

  return { dispatch, match, open, put, addAll, keys, deleteCache, fetch, skipWaiting, claim };
}

const failureModes = ["throws", "rejects"] as const;

describe("service worker optional asset cache", () => {
  it.each(["match", "open", "put"] as const)("keeps the network asset usable when cache %s rejects", async (operation) => {
    const fixture = workerFixture();
    const error = new DOMException("Storage is unavailable", operation === "put" ? "QuotaExceededError" : "SecurityError");
    fixture[operation].mockRejectedValueOnce(error);

    const event = fixture.dispatch("fetch", { request: new Request(assetUrl) });
    const response = await event.response;
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("network asset");
    await event.complete();
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture[operation]).toHaveBeenCalledOnce();
  });

  it.each(["match", "open", "put"] as const)("keeps the network asset usable when cache %s throws synchronously", async (operation) => {
    const fixture = workerFixture();
    fixture[operation].mockImplementationOnce(() => { throw new DOMException("Storage is unavailable", "SecurityError"); });

    const event = fixture.dispatch("fetch", { request: new Request(assetUrl) });
    expect(await (await event.response)?.text()).toBe("network asset");
    await event.complete();
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it("serves a cached asset without requiring a network connection", async () => {
    const fixture = workerFixture();
    const cached = new Response("cached asset");
    fixture.match.mockResolvedValueOnce(cached);

    const event = fixture.dispatch("fetch", { request: new Request(assetUrl) });
    expect(await event.response).toBe(cached);
    expect(await cached.text()).toBe("cached asset");
    await event.complete();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it("caches a clone of a successful asset without consuming its network response", async () => {
    const fixture = workerFixture();
    const request = new Request(assetUrl);
    const event = fixture.dispatch("fetch", { request });
    const response = await event.response;
    expect(await response?.text()).toBe("network asset");
    await event.complete();

    expect(fixture.put).toHaveBeenCalledOnce();
    const [cachedRequest, cachedResponse] = fixture.put.mock.calls[0]!;
    expect(cachedRequest).toBe(request);
    expect(cachedResponse).not.toBe(response);
    expect(await cachedResponse.text()).toBe("network asset");
  });

  it("preserves a real network failure when the cache misses", async () => {
    const fixture = workerFixture();
    const error = new TypeError("Network connection was lost");
    fixture.fetch.mockRejectedValueOnce(error);

    const event = fixture.dispatch("fetch", { request: new Request(assetUrl) });
    await expect(event.response).rejects.toBe(error);
    await event.complete();
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it("returns an unsuccessful server response without caching it", async () => {
    const fixture = workerFixture();
    fixture.fetch.mockResolvedValueOnce(new Response("asset unavailable", { status: 503 }));

    const event = fixture.dispatch("fetch", { request: new Request(assetUrl) });
    const response = await event.response;
    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe("asset unavailable");
    await event.complete();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it.each([
    ["private API", `${origin}/api/cases`, "GET"],
    ["another origin", "https://assets.example/_next/static/chunks/dispatch.js", "GET"],
    ["POST", assetUrl, "POST"],
  ])("does not intercept %s requests", async (_description, url, method) => {
    const fixture = workerFixture();
    const event = fixture.dispatch("fetch", { request: new Request(url, { method }) });
    expect(event.respondWith).not.toHaveBeenCalled();
    await event.complete();
    expect(fixture.match).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});

describe("service worker lifecycle with unavailable cache storage", () => {
  for (const mode of failureModes) {
    it.each(["open", "addAll"] as const)(`still installs the fixed worker when cache %s ${mode}`, async (operation) => {
      const fixture = workerFixture();
      const error = new DOMException("Storage quota exceeded", "QuotaExceededError");
      fixture[operation].mockImplementationOnce((): Promise<never> => {
        if (mode === "throws") throw error;
        return Promise.reject(error);
      });

      await fixture.dispatch("install").complete();
      expect(fixture[operation]).toHaveBeenCalledOnce();
      expect(fixture.skipWaiting).toHaveBeenCalledOnce();
    });

    it.each(["keys", "deleteCache"] as const)(`still takes control when cache cleanup %s ${mode}`, async (operation) => {
      const fixture = workerFixture();
      fixture[operation].mockImplementationOnce((): Promise<never> => {
        const error = new DOMException("Storage is unavailable", "SecurityError");
        if (mode === "throws") throw error;
        return Promise.reject(error);
      });

      await fixture.dispatch("activate").complete();
      expect(fixture[operation]).toHaveBeenCalledOnce();
      expect(fixture.claim).toHaveBeenCalledOnce();
    });
  }

  it("removes an old cache while retaining the current cache", async () => {
    const fixture = workerFixture();
    await fixture.dispatch("install").complete();
    const currentCacheName = fixture.open.mock.calls[0]![0];
    fixture.keys.mockResolvedValueOnce(["pm-dispatch-shell-old", currentCacheName]);

    await fixture.dispatch("activate").complete();
    expect(fixture.deleteCache).toHaveBeenCalledExactlyOnceWith("pm-dispatch-shell-old");
    expect(fixture.claim).toHaveBeenCalledOnce();
  });
});

describe("service worker navigation fallback", () => {
  const request = { method: "GET", url: `${origin}/`, mode: "navigate" };

  it("uses the network for authenticated pages without caching their content", async () => {
    const fixture = workerFixture();
    const event = fixture.dispatch("fetch", { request });
    expect(await (await event.response)?.text()).toBe("network asset");
    await event.complete();
    expect(fixture.match).not.toHaveBeenCalled();
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it("uses the generic offline page when the network fails", async () => {
    const fixture = workerFixture();
    fixture.fetch.mockRejectedValueOnce(new TypeError("Offline"));
    fixture.match.mockResolvedValueOnce(new Response("generic offline page"));

    const event = fixture.dispatch("fetch", { request });
    expect(await (await event.response)?.text()).toBe("generic offline page");
    await event.complete();
    expect(fixture.match).toHaveBeenCalledExactlyOnceWith("/offline");
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it.each(failureModes)("returns an error response when offline cache access %s", async (mode) => {
    const fixture = workerFixture();
    fixture.fetch.mockRejectedValueOnce(new TypeError("Offline"));
    fixture.match.mockImplementationOnce(() => {
      const error = new DOMException("Storage is unavailable", "SecurityError");
      if (mode === "throws") throw error;
      return Promise.reject(error);
    });

    const event = fixture.dispatch("fetch", { request });
    const response = await event.response;
    expect(response?.type).toBe("error");
    expect(response?.status).toBe(0);
    await event.complete();
  });
});
